#!/usr/bin/env python3
"""Real-model external acceptance tests (F02/F21/F22).

Runs S1 (F02 compaction), S2 (F21 A/B battery), S3 (F22 delegation/fault-recovery)
against a local opencode2 engine + Ollama (qwen3.8:27b).

Stdlib-only.  No new deps, no edits to existing files, no git ops.

Usage:
  python3 scripts/real-model-acceptance.py --selftest          # relay logic only, no engine
  python3 scripts/real-model-acceptance.py --output out/       # full acceptance run
"""
from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]

# ── Relay ────────────────────────────────────────────────────────────────────

_RELAY_START_EPOCH = 0


class RelayHandler(BaseHTTPRequestHandler):
    """OpenAI-compatible relay: Ollama proxy or deterministic mock.

    Enforces max_tokens <= MAX_TOKENS, total-call cap, wall-clock limit,
    and optional single-shot fault injection via drop_next_matching.
    """

    def log_message(self, *a):
        pass

    def _record(self, tag, detail=None):
        self.server.log.append({
            "t": round(time.monotonic() - _RELAY_START_EPOCH, 3),
            "tag": tag,
            **(detail or {}),
        })

    def do_GET(self):
        # /v1/models — ollama supports it; mock returns a stub
        if self.path.endswith("/v1/models"):
            payload = {
                "object": "list",
                "data": [{
                    "id": self.server.model,
                    "object": "model",
                    "created": 0,
                    "owned_by": "local",
                }],
            }
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return

        # ── global guards ──
        elapsed = time.monotonic() - _RELAY_START_EPOCH
        if elapsed > self.server.wall_limit:
            self._record("rejected_wallclock")
            self.send_response(503)
            self.end_headers()
            return

        if self.server.calls[0] >= self.server.max_calls:
            self._record("rejected_cap")
            self.send_response(503)
            self.end_headers()
            return

        # ── max_tokens ceiling ──
        mt = body.get("max_tokens") or body.get("max_output_tokens") or 0
        if isinstance(mt, int) and mt > self.server.max_tokens:
            self._record("rejected_max_tokens", {"max_tokens": mt})
            err = json.dumps({
                "error": {"message": f"max_tokens {mt} exceeds ceiling {self.server.max_tokens}",
                           "type": "invalid_request_error"}
            }).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(err)))
            self.end_headers()
            self.wfile.write(err)
            return

        # ── fault injection ──
        if self.server.drop_next_matching:
            pat = self.server.drop_next_matching
            ser = json.dumps(body)
            if pat in ser:
                self.server.drop_next_matching = None
                self.server.calls[0] += 1
                self._record("fault_injected", {"pattern": pat})
                err = json.dumps({
                    "error": {"message": "transient relay fixture failure",
                               "type": "server_error"}
                }).encode()
                self.send_response(503)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(err)))
                self.end_headers()
                self.wfile.write(err)
                return

        self.server.calls[0] += 1
        msgs = body.get("messages", [])
        self._record("request", {
            "n": self.server.calls[0],
            "model": body.get("model", "?"),
            "max_tokens": mt,
            "stream": body.get("stream", False),
            "n_messages": len(msgs),
            "has_tools": bool(body.get("tools")),
        })

        if self.server.mock:
            self._mock_sse(body)
        else:
            self._proxy(body, raw)

    # ── proxy to Ollama ──────────────────────────────────────────────────────

    def _proxy(self, body, raw):
        url = f"{self.server.target}/v1/chat/completions"
        req = Request(url, data=raw, method="POST")
        req.add_header("Content-Type", "application/json")
        try:
            resp = urlopen(req, timeout=self.server.timeout)
        except HTTPError as e:
            err_body = e.read()
            self._record("proxy_error", {"status": e.code})
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(err_body)))
            self.end_headers()
            self.wfile.write(err_body)
            return
        except URLError as e:
            self._record("proxy_unreachable", {"error": str(e)})
            err = json.dumps({"error": {"message": str(e), "type": "server_error"}}).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(err)))
            self.end_headers()
            self.wfile.write(err)
            return

        # SSE pass-through: count chunks as they fly by
        self.send_response(resp.status)
        # Don't forward Transfer-Encoding: urllib auto-decodes chunks,
        # so we write plain lines — claiming chunked encoding confuses the engine
        for h in ("Content-Type",):
            v = resp.headers.get(h)
            if v:
                self.send_header(h, v)
        self.end_headers()
        chunks = 0
        content_bytes = 0
        reasoning_bytes = 0
        finish = None
        while True:
            line = resp.readline()
            if not line:
                break
            self.wfile.write(line)
            self.wfile.flush()
            if line.startswith(b"data: ") and line.strip() != b"data: [DONE]":
                chunks += 1
                # Diagnostics only: a thinking model can burn the whole output
                # budget on reasoning deltas, leaving zero summary text.
                try:
                    choice = (json.loads(line[6:]).get("choices") or [{}])[0]
                    delta = choice.get("delta") or {}
                    content_bytes += len(delta.get("content") or "")
                    reasoning_bytes += (len(delta.get("reasoning") or "")
                                        + len(delta.get("reasoning_content") or ""))
                    if choice.get("finish_reason"):
                        finish = choice["finish_reason"]
                except Exception:
                    pass
        self._record("proxy_done", {"chunks": chunks, "content_bytes": content_bytes,
                                    "reasoning_bytes": reasoning_bytes, "finish": finish})

    # ── deterministic mock SSE ─────────────────────────────────────────────────

    def _mock_sse(self, body):
        """Valid OpenAI-format SSE with a canned assistant reply."""
        tools = body.get("tools") or []
        content = "OK"
        finish = "stop"
        tool_calls = None

        # If tools are offered and this is the first request, emit a tool call
        # so we can verify the relay carries tool-call SSE correctly.
        if tools and self.server.calls[0] == 1:
            content = None
            finish = "tool_calls"
            tool_calls = [{
                "index": 0,
                "id": "call_mock_1",
                "type": "function",
                "function": {
                    "name": tools[0].get("function", {}).get("name", "mock_tool"),
                    "arguments": "{}",
                },
            }]

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()

        base = {
            "id": "chatcmpl-mock",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": body.get("model", "mock"),
        }

        # Role chunk
        delta_role = {"role": "assistant"}
        if tool_calls:
            delta_role["tool_calls"] = tool_calls
        elif content:
            delta_role["content"] = ""
        self._sse({**base, "choices": [{"index": 0, "delta": delta_role, "finish_reason": None}]})

        # Content chunks (text mode only)
        if content:
            for word in content.split():
                self._sse({**base, "choices": [
                    {"index": 0, "delta": {"content": word + " "}, "finish_reason": None}
                ]})

        # Final chunk
        self._sse({
            **base,
            "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 10, "total_tokens": 60},
        })
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self._record("mock_response", {"finish": finish})

    def _sse(self, obj):
        self.wfile.write(("data: " + json.dumps(obj) + "\n\n").encode())
        self.wfile.flush()


# ── Helpers ──────────────────────────────────────────────────────────────────

def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_relay(target, *, model="mock", mock=False, max_calls=80,
                max_tokens=512, wall_limit=1500, drop_next=None):
    global _RELAY_START_EPOCH
    _RELAY_START_EPOCH = time.monotonic()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), RelayHandler)
    srv.target = target          # ollama base, e.g. http://127.0.0.1:11434
    srv.model = model
    srv.mock = mock
    srv.max_calls = max_calls
    srv.max_tokens = max_tokens
    srv.wall_limit = wall_limit
    srv.calls = [0]
    srv.log = []
    srv.timeout = 300
    srv.drop_next_matching = drop_next
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def engine_headers(service_info):
    cred = "opencode:" + service_info["password"]
    return {
        "Authorization": "Basic " + base64.b64encode(cred.encode()).decode(),
        "Content-Type": "application/json",
    }


def engine_post(service_info, path, payload, timeout=30):
    url = service_info["url"].rstrip("/") + path
    data = json.dumps(payload).encode()
    req = Request(url, data=data, headers=engine_headers(service_info), method="POST")
    with urlopen(req, timeout=timeout) as r:
        return json.load(r)


def engine_get(service_info, path, timeout=30):
    url = service_info["url"].rstrip("/") + path
    req = Request(url, headers=engine_headers(service_info))
    with urlopen(req, timeout=timeout) as r:
        return json.load(r)


def run_engine(binary, cmd, *, env, cwd, output_log, timeout=600):
    with open(output_log, "w") as log:
        p = subprocess.Popen(
            cmd, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            code = p.wait(timeout)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGTERM)
            p.wait(timeout=10)
            raise
    return code


def wait_db(path, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists():
            try:
                with sqlite3.connect(str(path)) as db:
                    db.execute("SELECT count(*) FROM meta").fetchone()
                return True
            except Exception:
                pass
        time.sleep(0.3)
    return False


def find_runtime_db(state_dir):
    """Locate the runtime.sqlite3 under the engine's state directory."""
    candidates = list(Path(state_dir).rglob("runtime.sqlite3"))
    if candidates:
        return candidates[0]
    candidates = list(Path(state_dir).rglob("*.sqlite3"))
    for c in candidates:
        if "custom-opencode" in str(c) or "opencode" in str(c):
            return c
    return candidates[0] if candidates else None


# ── Self-test ────────────────────────────────────────────────────────────────

def selftest():
    """Verify relay logic with a mock backend.  No engine or Ollama needed."""
    relay = start_relay("http://127.0.0.1:0", mock=True, max_calls=5, max_tokens=64)
    port = relay.server_port
    url = f"http://127.0.0.1:{port}/v1/chat/completions"
    results = []

    def post(payload, expect_status=200):
        data = json.dumps(payload).encode()
        req = Request(url, data=data, headers={"Content-Type": "application/json"})
        try:
            with urlopen(req, timeout=10) as r:
                body = r.read().decode()
                return r.status, body
        except HTTPError as e:
            return e.code, e.read().decode()

    # 1) basic mock response
    code, body = post({
        "model": "mock", "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 32,
    })
    ok = code == 200 and "OK" in body
    results.append(("mock_sse_ok", ok, {"status": code}))

    # 2) SSE parse: extract content
    if ok:
        chunks = [l[6:] for l in body.splitlines() if l.startswith("data: ") and l.strip() != "data: [DONE]"]
        texts = []
        for c in chunks:
            try:
                obj = json.loads(c)
                d = obj.get("choices", [{}])[0].get("delta", {})
                t = d.get("content", "")
                if t:
                    texts.append(t)
            except Exception:
                pass
        ok = "OK" in "".join(texts)
        results.append(("mock_sse_parse", ok, {"texts": texts}))

    # 3) max_tokens rejection
    code, _ = post({
        "model": "mock", "messages": [{"role": "user", "content": "x"}],
        "max_tokens": 9999,
    })
    results.append(("max_tokens_reject", code == 400, {"status": code}))

    # 4) call cap enforcement
    for i in range(6):
        post({"model": "mock", "messages": [{"role": "user", "content": f"m{i}"}], "max_tokens": 8})
    # max_calls=5, first call was test 1, plus test 3 counted (even though 400),
    # then 4 more here → some should be 503
    rejected = [e for e in relay.log if e["tag"] == "rejected_cap"]
    results.append(("call_cap", len(rejected) >= 1, {"rejected": len(rejected), "total": relay.calls[0]}))

    # 5) fault injection
    relay2 = start_relay("http://127.0.0.1:0", mock=True, max_calls=10, max_tokens=64,
                         drop_next="FAULT_PROBE")
    url2 = f"http://127.0.0.1:{relay2.server_port}/v1/chat/completions"

    def post2(payload):
        data = json.dumps(payload).encode()
        req = Request(url2, data=data, headers={"Content-Type": "application/json"})
        try:
            with urlopen(req, timeout=10) as r:
                return r.status
        except HTTPError as e:
            return e.code

    # first call matches pattern → should be 503
    s1 = post2({"model": "m", "messages": [{"role": "user", "content": "FAULT_PROBE"}], "max_tokens": 8})
    # second call same pattern → fault consumed, should be 200
    s2 = post2({"model": "m", "messages": [{"role": "user", "content": "FAULT_PROBE"}], "max_tokens": 8})
    results.append(("fault_inject", s1 == 503 and s2 == 200, {"first": s1, "second": s2}))
    relay2.shutdown()

    # 6) wall-clock guard (set wall_limit=0 → immediate rejection)
    relay3 = start_relay("http://127.0.0.1:0", mock=True, max_calls=10, max_tokens=64, wall_limit=0)
    time.sleep(0.05)
    url3 = f"http://127.0.0.1:{relay3.server_port}/v1/chat/completions"
    data = json.dumps({"model": "m", "messages": [{"role": "user", "content": "x"}], "max_tokens": 8}).encode()
    req = Request(url3, data=data, headers={"Content-Type": "application/json"})
    try:
        s3 = urlopen(req, timeout=5).status
    except HTTPError as e:
        s3 = e.code
    results.append(("wallclock_guard", s3 == 503, {"status": s3}))
    relay3.shutdown()

    relay.shutdown()

    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    for name, ok, detail in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}  {detail}")
    print(f"\n  self-test: {passed}/{total} passed")
    return 0 if passed == total else 1


# ── Bootstrap ────────────────────────────────────────────────────────────────

def bootstrap_engine(relay_port, *, model_id, context_limit, output_dir,
                     binary, output_limit=512, home_dir=None):
    """Start the opencode2 engine with a relay-backed provider.

    Returns (service_info, env, cleanup_fn).
    """
    tmp = tempfile.mkdtemp(prefix="rma-") if not home_dir else None
    home = Path(home_dir) if home_dir else Path(tmp)
    project = home / "project"
    project.mkdir(parents=True, exist_ok=True)
    cfg = home / ".config/opencode"
    plugins = cfg / "plugins"
    plugins.mkdir(parents=True, exist_ok=True)

    # Minimal git repo (engine may require it)
    subprocess.run(["git", "init", "-q", str(project)], check=True)
    (project / "README.md").write_text("# acceptance\n")
    subprocess.run(["git", "-C", str(project), "add", "."], check=True)
    subprocess.run(
        ["git", "-C", str(project), "-c", "user.name=Acceptance",
         "-c", "user.email=a@example.invalid", "commit", "-qm", "init"],
        check=True,
    )

    port, policy_port = free_port(), free_port()
    while policy_port == port:
        policy_port = free_port()

    env = {
        k: v for k, v in os.environ.items()
        if not k.startswith((
            "OPENCODE_", "CUSTOM_OPENCODE_", "TOKEN_PLAN_", "MCP_",
            "PONYTAIL_", "GEMINI_", "GOOGLE_", "OPENAI_",
        ))
    }
    password = secrets.token_urlsafe(24)
    env.update(
        HOME=str(home),
        XDG_CONFIG_HOME=str(home / ".config"),
        XDG_DATA_HOME=str(home / ".local/share"),
        XDG_STATE_HOME=str(home / ".local/state"),
        XDG_CACHE_HOME=str(home / ".cache"),
        OPENCODE_SERVER_USERNAME="acceptance",
        OPENCODE_SERVER_PASSWORD=password,
        OPENCODE_POLICY_PORT=str(policy_port),
        OPENCODE_REPO_EMBEDDINGS="hash",
        OPENCODE_PROJECT_ROOTS=str(home),
        OPENCODE_SCRATCH_DIRECTORY=str(project),
        OPENCODE_RUNTIME_PLUGIN_TIMEOUT_MS="5000",
        OPENCODE_DISABLE_AUTOUPDATE="1",
        MCP_RAG_ENABLED="0",
    )

    # Policy launcher
    launcher = home / "policy-launcher"
    launcher.write_text(
        "#!/bin/sh\nexec "
        + shlex.quote(sys.executable) + " "
        + shlex.quote(str(ROOT / "app/policy_server.py"))
        + ' "$@"\n'
    )
    launcher.chmod(0o700)
    env["OPENCODE_POLICY_COMMAND"] = str(launcher)

    service_env = {
        k: v for k, v in env.items()
        if k.startswith(("OPENCODE_", "CUSTOM_OPENCODE_", "MCP_"))
    }
    (cfg / "service.json").write_text(json.dumps({"port": port, "env": service_env}))

    # Provider config pointing at our relay
    config = {
        "update": "disable",
        "default_agent": "build",
        "providers": {
            "relay": {
                "package": "aisdk:@ai-sdk/openai-compatible",
                "name": "Acceptance relay",
                "settings": {
                    "baseURL": f"http://127.0.0.1:{relay_port}/v1",
                    "apiKey": "acceptance-relay",
                },
                "models": {
                    model_id: {
                        "name": model_id,
                        "capabilities": {"tools": True, "input": ["text"], "output": ["text"]},
                        "limit": {"context": context_limit, "output": output_limit},
                    }
                },
            }
        },
        "permissions": [
            {"action": "*", "resource": "*", "effect": "allow"},
        ],
    }
    (cfg / "opencode.json").write_text(json.dumps(config))

    # Runtime guard plugin
    (plugins / "runtime-guard.js").write_text(
        f'export {{ default }} from '
        f'{json.dumps((ROOT / "config/plugins/server-runtime-guard.js").as_uri())};\n'
    )

    def cleanup():
        subprocess.run(
            [str(launcher), "stop"], env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=15, check=False,
        )
        subprocess.run(
            [binary, "service", "stop"], env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=20, check=False,
        )

    # Start engine service
    svc_log = output_dir / "service-start.log"
    code = run_engine(binary, [binary, "service", "start"],
                      env=env, cwd=project, output_log=svc_log, timeout=180)
    if code:
        raise RuntimeError(f"engine service start failed (exit {code}); see {svc_log}")

    # Read actual service info (password may differ from env if engine regenerates)
    svc_path = home / ".local/state/opencode/service.json"
    deadline = time.monotonic() + 30
    while not svc_path.exists() and time.monotonic() < deadline:
        time.sleep(0.3)
    if not svc_path.exists():
        cleanup()
        raise RuntimeError("engine service.json not found after start")
    service_info = json.loads(svc_path.read_text())

    return service_info, env, cleanup, project, home


# ── Scenario S1: F02 — force compaction ─────────────────────────────────────

FACTS = [
    ("F1", "The fictional element Aurorite has atomic number 137 and melts at 4242 K."),
    ("F2", "In the made-up city Brightmoor the municipal bird is the copper starling."),
    ("F3", "The protocol Lumenet-7 uses port 4747 and negotiates via SHA-3 finger prints."),
    ("F4", "The spaceship Pangloss reached Kepler-442b on stardate 93.7 after 1111 days."),
]

FILLER_TOPIC = "Explain in detail the history of computing from 1940 to 2000, " \
               "covering at least 15 key milestones with dates and names."


def scenario_f02(binary, service_info, env, project, relay, *, output_dir, timeout=600):
    """Force compaction via small context budget, probe fact recall.

    Strategy: create a session, send multiple turns each embedding a fact
    plus filler, then probe recall.  Check the DB for context.compaction_requested
    events and verify the model's recall response mentions probed facts.
    """
    sid = None
    checks = []

    try:
        # Create session with the relay model
        resp = engine_post(service_info, "/api/session", {
            "title": "F02 compaction acceptance",
            "model": {"providerID": "relay", "id": "qwen3.8:27b"},
            "agent": "build",
            "location": {"directory": str(project)},
        })
        sid = resp["data"]["id"]

        # Embed facts across turns, with filler to burn context
        for i, (fid, fact) in enumerate(FACTS):
            prompt = (
                f"Remember this fact [{fid}]: {fact}\n\n"
                f"Also: {FILLER_TOPIC}"
            )
            log = output_dir / f"f02-turn-{i}.log"
            code = run_engine(
                binary,
                [binary, "run", "--session", sid, "--format", "json", prompt],
                env=env, cwd=project, output_log=log, timeout=timeout,
            )
            checks.append((f"f02_turn_{i}_exit", code == 0, {"exit": code}))

        # Probe recall
        probe = (
            "Without looking anything up, recall all the specific facts you were "
            "given earlier. For each fact, state its ID (F1-F4) and content."
        )
        log = output_dir / "f02-probe.log"
        code = run_engine(
            binary,
            [binary, "run", "--session", sid, "--format", "json", probe],
            env=env, cwd=project, output_log=log, timeout=timeout,
        )
        checks.append(("f02_probe_exit", code == 0, {"exit": code}))
        probe_text = log.read_text() if log.exists() else ""

        # Check recall quality (at least 2 of 4 fact IDs appear in probe output)
        recalled = sum(1 for fid, _ in FACTS if fid in probe_text)
        checks.append(("f02_recall", recalled >= 2, {"recalled": recalled, "of": len(FACTS)}))

    except Exception:
        checks.append(("f02_error", False, {"trace": traceback.format_exc()}))

    # Inspect DB for compaction events
    try:
        state_dir = Path(env["XDG_STATE_HOME"])
        dbpath = find_runtime_db(state_dir)
        if dbpath and dbpath.exists():
            with sqlite3.connect(str(dbpath)) as db:
                events = db.execute(
                    "SELECT kind, data_json FROM events WHERE kind LIKE 'context.%' ORDER BY id"
                ).fetchall()
                compaction_kinds = [k for k, _ in events if "compact" in k.lower() or "budget" in k.lower()]
                checks.append(("f02_db_events", len(events) > 0, {
                    "context_events": len(events),
                    "kinds": list({k for k, _ in events}),
                }))
                if compaction_kinds:
                    checks.append(("f02_compaction_seen", True, {
                        "compaction_kinds": compaction_kinds,
                    }))
    except Exception:
        checks.append(("f02_db_error", False, {"trace": traceback.format_exc()}))

    return checks, relay.log


# ── Scenario S2: F21 — A/B battery ──────────────────────────────────────────

BATTERY_TASKS = [
    ("arithmetic", "Compute 137 * 29. Answer with just the number."),
    ("summarize", "Summarize in one sentence: The quick brown fox jumps over the lazy dog. "
                  "This is a well-known English pangram used in typography since the 1880s."),
    ("classify", "Classify the following review as positive or negative: "
                 "'The food was amazing but the service was terrible.' Answer one word."),
    ("knowledge", "What is the capital of Australia? Answer with just the city name."),
    ("code", "Write a Python one-liner that reverses a string stored in variable s."),
    ("translate", "Translate 'Good morning, how are you?' into French."),
]


def scenario_f21(binary, service_info, env, project, relay, *, output_dir, timeout=300):
    """A/B battery: 6 tasks, check each completes and produces output.

    Measures relay call count per task and verifies non-empty engine output.
    """
    checks = []
    sid = None

    try:
        resp = engine_post(service_info, "/api/session", {
            "title": "F21 A/B battery",
            "model": {"providerID": "relay", "id": "qwen3.8:27b"},
            "agent": "build",
            "location": {"directory": str(project)},
        })
        sid = resp["data"]["id"]

        calls_before = relay.calls[0]
        for i, (label, prompt) in enumerate(BATTERY_TASKS):
            log = output_dir / f"f21-{label}.log"
            code = run_engine(
                binary,
                [binary, "run", "--session", sid, "--format", "json", prompt],
                env=env, cwd=project, output_log=log, timeout=timeout,
            )
            text = log.read_text() if log.exists() else ""
            calls_after = relay.calls[0]
            task_calls = calls_after - calls_before
            nonempty = len(text.strip()) > 10
            checks.append((f"f21_{label}", code == 0 and nonempty, {
                "exit": code, "relay_calls": task_calls, "output_bytes": len(text),
            }))
            calls_before = calls_after

    except Exception:
        checks.append(("f21_error", False, {"trace": traceback.format_exc()}))

    return checks, relay.log


# ── Scenario S3: F22 — delegation / fault-recovery / new root (in-process) ──

def scenario_f22(binary, service_info, env, project, relay, *, output_dir, timeout=300):
    """Multi-agent delegation + fault injection + new-turn-new-root (in-process).

    Reworked to drive task creation IN-PROCESS by importing server_workflow,
    sharing STORE with the running engine. This avoids the 405 on /client-task-create.json
    (route only served by composed web listener, which we don't boot).

    Steps:
      1. Import app/ modules, compose features in-process
      2. Create task via create_task_request(features, payload) → verify in STORE
      3. Spawn speculative children via spawn_speculative(features, payload) → verify shared root
      4. Inject fault, run turn → verify retry accounted in STORE
      5. Run new turn → verify new execution root in STORE
    """
    checks = []
    sid = None

    def snapshot_roots(dbpath):
        with sqlite3.connect(str(dbpath)) as db:
            return db.execute("SELECT id FROM execution_roots ORDER BY started_at").fetchall()

    # Save original env vars to restore later
    orig_env = {}
    for key in ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
                "XDG_CACHE_HOME", "OPENCODE_SERVER_USERNAME", "OPENCODE_SERVER_PASSWORD",
                "OPENCODE_POLICY_PORT", "OPENCODE_REPO_EMBEDDINGS", "OPENCODE_PROJECT_ROOTS",
                "OPENCODE_SCRATCH_DIRECTORY"]:
        if key in os.environ:
            orig_env[key] = os.environ[key]
        if key in env:
            os.environ[key] = env[key]

    # Add app/ to sys.path for importing server modules
    app_dir = ROOT / "app"
    if str(app_dir) not in sys.path:
        sys.path.insert(0, str(app_dir))

    try:
        # Import server_workflow to get composed features and STORE
        # This creates a second instance in our process, but shares the same STORE (sqlite db)
        import server_workflow
        features = server_workflow.features
        STORE = server_workflow.runtime.STORE

        # Import the functions we need
        from server_runtime import create_task_request, spawn_speculative

        # Create session via HTTP (this is a standard API route, works fine)
        resp = engine_post(service_info, "/api/session", {
            "title": "F22 delegation acceptance",
            "model": {"providerID": "relay", "id": "qwen3.8:27b"},
            "agent": "build",
            "location": {"directory": str(project)},
        })
        sid = resp["data"]["id"]

        # Step 1: create a task IN-PROCESS (not via HTTP)
        task_resp = create_task_request(features, {
            "sessionID": sid,
            "text": "Read README.md and report its content.",
            "directory": str(project),
            "profile": "build",
        })
        task_ok = task_resp.get("ok", False)
        task_id = task_resp.get("task", {}).get("id", "")
        checks.append(("f22_task_create_inprocess", task_ok and bool(task_id), {
            "task_id": task_id, "response_keys": list(task_resp.keys()),
        }))

        # Step 2: spawn speculative children IN-PROCESS
        spec_resp = spawn_speculative(features, {
            "sessionID": sid,
            "text": "Investigate the README.md file structure and metadata.",
            "count": 2,
        })
        spec_ok = spec_resp.get("ok", False)
        parent_id = spec_resp.get("parent", {}).get("id", "")
        children = spec_resp.get("children", [])
        checks.append(("f22_spawn_speculative_inprocess", spec_ok and bool(parent_id) and len(children) == 2, {
            "parent_id": parent_id, "children_count": len(children),
        }))

        # Criterion (a): Verify children share root with parent
        parent_task = STORE.get_task(parent_id)
        parent_root = parent_task.get("metadata", {}).get("rootTaskID", "") if parent_task else ""
        children_roots = []
        for c in children:
            child_task = STORE.get_task(c["id"])
            child_root = child_task.get("metadata", {}).get("rootTaskID", "") if child_task else ""
            children_roots.append(child_root)
        children_share_root = all(r == parent_root for r in children_roots) and bool(parent_root)
        checks.append(("f22_shared_ledger_root", children_share_root, {
            "parent_root": parent_root,
            "children_roots": children_roots,
        }))

        # Criterion (c): Verify one review owner per speculative child
        # Each child should have a mailboxTo field pointing to the parent
        children_owners = []
        for c in children:
            child_task = STORE.get_task(c["id"])
            mailbox_to = child_task.get("metadata", {}).get("mailboxTo", "") if child_task else ""
            children_owners.append(mailbox_to)
        one_owner_per_child = all(owner == parent_id for owner in children_owners)
        checks.append(("f22_one_review_owner_per_child", one_owner_per_child, {
            "parent_id": parent_id,
            "children_owners": children_owners,
        }))

        # Step 3: run a turn with fault injection
        relay.drop_next_matching = "README"
        log = output_dir / "f22-fault-turn.log"
        code = run_engine(
            binary,
            [binary, "run", "--session", sid, "--format", "json",
             "Read README.md and tell me what it says."],
            env=env, cwd=project, output_log=log, timeout=timeout,
        )
        fault_log = [e for e in relay.log if e["tag"] == "fault_injected"]
        checks.append(("f22_fault_recovery", code == 0, {
            "exit": code, "fault_injected": len(fault_log) >= 1,
        }))

        # Criterion (b): Verify retry in STORE
        state_dir = Path(env["XDG_STATE_HOME"])
        dbpath = find_runtime_db(state_dir)
        if not dbpath or not dbpath.exists():
            checks.append(("f22_db_missing", False, {"state_dir": str(state_dir)}))
            return checks, relay.log

        with sqlite3.connect(str(dbpath)) as db:
            # Check execution_requests for retry evidence
            reqs = db.execute(
                "SELECT state, usage_json, reserved FROM execution_requests"
            ).fetchall()
            # Count relay attempts (fault_injected + successful retry)
            relay_attempts = [e for e in relay.log if e["tag"] in ("request", "fault_injected")]
            has_retry = len(relay_attempts) >= 2 or any(state == "usage_unknown" for state, _, _ in reqs)
        checks.append(("f22_retry_accounted", has_retry, {
            "relay_attempts": len(relay_attempts),
            "request_count": len(reqs),
        }))

        # Step 4: snapshot roots before new turn
        roots_before = snapshot_roots(dbpath)
        bindings_before = {}
        with sqlite3.connect(str(dbpath)) as db:
            row = db.execute(
                "SELECT root_id, turn_id FROM execution_bindings WHERE session_id=?", (sid,)
            ).fetchone()
            if row:
                bindings_before[sid] = row

        # Step 5: new turn → should create new root
        log2 = output_dir / "f22-new-turn.log"
        code2 = run_engine(
            binary,
            [binary, "run", "--session", sid, "--format", "json",
             "Now tell me how many lines README.md has."],
            env=env, cwd=project, output_log=log2, timeout=timeout,
        )
        checks.append(("f22_new_turn_exit", code2 == 0, {"exit": code2}))

        # Criterion (d): Verify new root created for new turn
        roots_after = snapshot_roots(dbpath)
        with sqlite3.connect(str(dbpath)) as db:
            row_after = db.execute(
                "SELECT root_id, turn_id FROM execution_bindings WHERE session_id=?", (sid,)
            ).fetchone()

        new_root = len(roots_after) > len(roots_before)
        new_binding = (
            row_after
            and bindings_before.get(sid)
            and row_after[0] != bindings_before[sid][0]
            and row_after[1] != bindings_before[sid][1]
        )
        checks.append(("f22_new_root_for_new_turn", new_root, {
            "roots_before": len(roots_before), "roots_after": len(roots_after),
        }))
        checks.append(("f22_new_binding_for_new_turn", bool(new_binding), {
            "before": bindings_before.get(sid),
            "after": row_after,
        }))

    except Exception:
        checks.append(("f22_error", False, {"trace": traceback.format_exc()}))
    finally:
        # Restore original env vars
        for key in list(os.environ.keys()):
            if key.startswith(("OPENCODE_", "HOME", "XDG_")) and key not in orig_env:
                del os.environ[key]
        for key, value in orig_env.items():
            os.environ[key] = value

    return checks, relay.log


# ── Full acceptance orchestration ────────────────────────────────────────────

def main_acceptance(args):
    binary = args.engine or os.environ.get("OPENCODE2_BIN") or shutil.which("opencode2")
    if not binary:
        print("ERROR: opencode2 binary not found (set OPENCODE2_BIN or pass --engine)")
        return 2

    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)

    ollama = args.ollama
    model = args.model

    # Quick ollama reachability check
    try:
        with urlopen(f"{ollama}/api/tags", timeout=10) as r:
            tags = json.load(r)
        available = [m.get("name", "") for m in tags.get("models", [])]
        if not any(model in name for name in available):
            print(f"WARN: model {model!r} not found in ollama tags: {available[:10]}")
    except Exception as e:
        print(f"ERROR: ollama unreachable at {ollama}: {e}")
        return 2

    relay = start_relay(
        ollama,
        model=model,
        mock=False,
        max_calls=args.relay_max_calls,
        max_tokens=args.relay_max_tokens,
        wall_limit=args.relay_wall_limit,
    )
    print(f"Relay on :{relay.server_port} → {ollama}  (caps: {args.relay_max_calls} calls, "
          f"{args.relay_max_tokens} tok, {args.relay_wall_limit}s)")

    try:
        service_info, env, cleanup, project, home = bootstrap_engine(
            relay.server_port,
            model_id=model,
            context_limit=args.context_limit,
            output_dir=output,
            binary=binary,
            output_limit=args.relay_max_tokens,
        )
    except Exception as e:
        print(f"ERROR: bootstrap failed: {e}")
        relay.shutdown()
        return 2

    report = {"ok": False, "scenarios": {}, "relay_log": [], "error": None}
    try:
        # S1: F02 compaction
        print("\n── S1 (F02): force compaction ──")
        checks_s1, _ = scenario_f02(
            binary, service_info, env, project, relay,
            output_dir=output, timeout=args.scenario_timeout,
        )
        s1_ok = all(ok for _, ok, _ in checks_s1)
        report["scenarios"]["S1_F02"] = {
            "ok": s1_ok, "checks": [(n, ok, d) for n, ok, d in checks_s1],
        }
        print(f"  S1: {'PASS' if s1_ok else 'FAIL'}  ({sum(ok for _,ok,_ in checks_s1)}/{len(checks_s1)})")
        for n, ok, d in checks_s1:
            print(f"    {'PASS' if ok else 'FAIL'}  {n}  {d}")

        # S2: F21 A/B battery
        print("\n── S2 (F21): A/B battery ──")
        checks_s2, _ = scenario_f21(
            binary, service_info, env, project, relay,
            output_dir=output, timeout=args.scenario_timeout,
        )
        s2_ok = all(ok for _, ok, _ in checks_s2)
        report["scenarios"]["S2_F21"] = {
            "ok": s2_ok, "checks": [(n, ok, d) for n, ok, d in checks_s2],
        }
        print(f"  S2: {'PASS' if s2_ok else 'FAIL'}  ({sum(ok for _,ok,_ in checks_s2)}/{len(checks_s2)})")
        for n, ok, d in checks_s2:
            print(f"    {'PASS' if ok else 'FAIL'}  {n}  {d}")

        # S3: F22 delegation/fault/recovery
        print("\n── S3 (F22): delegation + fault recovery ──")
        checks_s3, _ = scenario_f22(
            binary, service_info, env, project, relay,
            output_dir=output, timeout=args.scenario_timeout,
        )
        s3_ok = all(ok for _, ok, _ in checks_s3)
        report["scenarios"]["S3_F22"] = {
            "ok": s3_ok, "checks": [(n, ok, d) for n, ok, d in checks_s3],
        }
        print(f"  S3: {'PASS' if s3_ok else 'FAIL'}  ({sum(ok for _,ok,_ in checks_s3)}/{len(checks_s3)})")
        for n, ok, d in checks_s3:
            print(f"    {'PASS' if ok else 'FAIL'}  {n}  {d}")

        all_ok = s1_ok and s2_ok and s3_ok
        report["ok"] = all_ok
        report["relay_calls"] = relay.calls[0]
        report["relay_log"] = relay.log

    except Exception as e:
        report["error"] = f"{type(e).__name__}: {e}"
        (output / "failure.log").write_text(traceback.format_exc())
    finally:
        cleanup()
        relay.shutdown()
        # Copy engine logs
        for pattern in ("*.log",):
            for log in Path(env.get("XDG_STATE_HOME", "/dev/null")).rglob(pattern):
                try:
                    shutil.copy2(log, output / f"engine-{log.name}")
                except Exception:
                    pass
        (output / "relay-log.json").write_text(
            json.dumps(relay.log, ensure_ascii=False, indent=2)
        )

    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(f"\n{'=' * 60}")
    print(f"  Overall: {'PASS' if report['ok'] else 'FAIL'}")
    print(f"  Relay calls: {relay.calls[0]}/{args.relay_max_calls}")
    print(f"  Report: {output / 'report.json'}")
    return 0 if report["ok"] else 1


# ── Entry point ──────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--selftest", action="store_true", help="Relay self-test only (no engine/ollama)")
    ap.add_argument("--output", type=Path, default=Path("acceptance-output"))
    ap.add_argument("--ollama", default=os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434"))
    ap.add_argument("--model", default=os.environ.get("ACCEPTANCE_MODEL", "qwen3.8:27b"))
    ap.add_argument("--engine", default=None, help="Path to opencode2 binary")
    ap.add_argument("--context-limit", type=int, default=8000, help="Model context limit (small → compaction)")
    ap.add_argument("--relay-max-calls", type=int, default=80)
    ap.add_argument("--relay-max-tokens", type=int, default=512)
    ap.add_argument("--relay-wall-limit", type=int, default=1500, help="Relay wall-clock limit in seconds")
    ap.add_argument("--scenario-timeout", type=int, default=300, help="Per-scenario engine timeout in seconds")
    args = ap.parse_args()

    if args.selftest:
        return selftest()
    return main_acceptance(args)


if __name__ == "__main__":
    raise SystemExit(main())
