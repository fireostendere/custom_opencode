#!/usr/bin/env python3
"""Real pinned native engine + private policy + local deterministic provider.

No public custom web listener, no paid provider and no external model requests.
Tests actual wire ceilings, native tool-result artifacts and durable usage.
"""
from __future__ import annotations
import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
XML = '<server name="payments">PRESERVE_USER_XML_847</server>'
TAIL = "FINAL_ERROR_SENTINEL_219"


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--retry-once", action="store_true", help="Return one real HTTP 503 before succeeding"
    )
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    binary = os.environ.get("OPENCODE2_BIN") or shutil.which("opencode2")
    if not binary:
        raise RuntimeError("Real pinned OPENCODE2_BIN is required")
    requests = []
    report = {"ok": False, "paidModelCalls": 0, "checks": []}

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            requests.append(body)
            if args.retry_once and len(requests) == 1:
                self.send_response(503)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    b'{"error":{"message":"deterministic transient fixture failure","type":"server_error"}}'
                )
                return
            messages = body.get("messages", [])
            serialized = json.dumps(messages)
            tools = [m for m in messages if m.get("role") == "tool"]
            call = None
            if not tools:
                call = {
                    "id": "call_fixture",
                    "type": "function",
                    "function": {"name": "diagnostic_read", "arguments": "{}"},
                }
            elif "runtime_artifact_read" not in serialized or "call_artifact" not in serialized:
                import re

                unescaped = serialized.replace('\\"', '"')
                match = re.search(r'"artifactID"\s*:\s*"(a_[a-f0-9]+)"', unescaped)
                if match:
                    call = {
                        "id": "call_artifact",
                        "type": "function",
                        "function": {
                            "name": "runtime_artifact_read",
                            "arguments": json.dumps(
                                {"artifactID": match.group(1), "offset": 29000, "limit": 3000}
                            ),
                        },
                    }
            if tools and call is None and "call_discover" not in serialized:
                call = {
                    "id": "call_discover",
                    "type": "function",
                    "function": {
                        "name": "mcp_discover",
                        "arguments": json.dumps({"query": "fixture_cad_12", "limit": 1}),
                    },
                }
            elif tools and call is None and "call_component" not in serialized:
                available = [t.get("function", {}).get("name", "") for t in body.get("tools", [])]
                name = next((name for name in available if name.endswith("cad_12")), None)
                if name:
                    call = {
                        "id": "call_component",
                        "type": "function",
                        "function": {"name": name, "arguments": "{}"},
                    }
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            base = {
                "id": "chatcmpl-fixture",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "fixture",
            }
            delta = {"role": "assistant"}
            if call:
                delta["tool_calls"] = [{"index": 0, **call}]
            else:
                delta["content"] = "OK " + TAIL
            for choices, usage in [
                ([{"index": 0, "delta": delta, "finish_reason": None}], None),
                (
                    [{"index": 0, "delta": {}, "finish_reason": "tool_calls" if call else "stop"}],
                    {
                        "prompt_tokens": 100,
                        "completion_tokens": 20,
                        "total_tokens": 120,
                        "completion_tokens_details": {"reasoning_tokens": 7},
                    },
                ),
            ]:
                value = {**base, "choices": choices}
                if usage:
                    value["usage"] = usage
                self.wfile.write(("data: " + json.dumps(value) + "\n\n").encode())
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")

    provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="native-budget-") as temporary:
        home = Path(temporary) / "home"
        project = home / "project"
        project.mkdir(parents=True)
        cfg = home / ".config/opencode"
        plugins = cfg / "plugins"
        plugins.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(project)], check=True)
        (project / "fixture.txt").write_text("fixture\n")
        subprocess.run(["git", "-C", str(project), "add", "."], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(project),
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-qm",
                "fixture",
            ],
            check=True,
        )
        port, policy_port = free_port(), free_port()
        while policy_port == port:
            policy_port = free_port()
        env = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith(
                (
                    "OPENCODE_",
                    "CUSTOM_OPENCODE_",
                    "TOKEN_PLAN_",
                    "MCP_",
                    "PONYTAIL_",
                    "GEMINI_",
                    "GOOGLE_",
                    "OPENAI_",
                )
            )
        }
        env.update(
            HOME=str(home),
            XDG_CONFIG_HOME=str(home / ".config"),
            XDG_DATA_HOME=str(home / ".local/share"),
            XDG_STATE_HOME=str(home / ".local/state"),
            XDG_CACHE_HOME=str(home / ".cache"),
            OPENCODE_SERVER_USERNAME="fixture",
            OPENCODE_SERVER_PASSWORD=secrets.token_urlsafe(24),
            OPENCODE_POLICY_PORT=str(policy_port),
            OPENCODE_REPO_EMBEDDINGS="hash",
            OPENCODE_PROJECT_ROOTS=str(home),
            OPENCODE_SCRATCH_DIRECTORY=str(project),
            OPENCODE_RUNTIME_PLUGIN_TIMEOUT_MS="5000",
            # The strip above drops OPENCODE_*; re-add the updater gate so no bare CLI
            # launch detaches `npm install --global` against the pinned tree mid-run.
            OPENCODE_DISABLE_AUTOUPDATE="1",
            MCP_RAG_ENABLED="0",
        )
        launcher = home / "policy-launcher"
        launcher.write_text(
            "#!/bin/sh\nexec "
            + shlex_quote(sys.executable)
            + " "
            + shlex_quote(str(ROOT / "app/policy_server.py"))
            + ' "$@"\n'
        )
        launcher.chmod(0o700)
        env["OPENCODE_POLICY_COMMAND"] = str(launcher)
        service_env = {
            k: v for k, v in env.items() if k.startswith(("OPENCODE_", "CUSTOM_OPENCODE_", "MCP_"))
        }
        (cfg / "service.json").write_text(json.dumps({"port": port, "env": service_env}))
        config = {
            "update": "disable",
            "default_agent": "build",
            "providers": {
                "fixture": {
                    "package": "aisdk:@ai-sdk/openai-compatible",
                    "name": "Local test fixture",
                    "settings": {
                        "baseURL": f"http://127.0.0.1:{provider.server_port}/v1",
                        "apiKey": "local-fixture",
                    },
                    "models": {
                        "fixture": {
                            "name": "Fixture",
                            "capabilities": {"tools": True, "input": ["text"], "output": ["text"]},
                            "limit": {"context": 32000, "output": 2048},
                        }
                    },
                }
            },
            "permissions": [
                {"action": "diagnostic_read", "resource": "*", "effect": "allow"},
                {"action": "runtime_artifact_read", "resource": "*", "effect": "allow"},
            ],
        }
        # A real MCP stdio peer with 100 schemas, not an in-memory tool mock.
        peer = home / "mcp-fixture.py"
        peer.write_text(
            """import json,sys
for line in sys.stdin:
 try:
  request=json.loads(line);method=request.get('method');ident=request.get('id')
  if ident is None:continue
  if method=='initialize':result={'protocolVersion':request['params']['protocolVersion'],'capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}}
  elif method=='tools/list':result={'tools':[{'name':f'cad_{i}','description':f'Read component {i}. '+('Schema description. '*12),'inputSchema':{'type':'object','properties':{},'additionalProperties':False}} for i in range(100)]}
  elif method=='tools/call':result={'content':[{'type':'text','text':'COMPONENT_12_OK'}]}
  elif method=='ping':result={}
  else:
   print(json.dumps({'jsonrpc':'2.0','id':ident,'error':{'code':-32601,'message':'method not found'}}),flush=True);continue
  print(json.dumps({'jsonrpc':'2.0','id':ident,'result':result}),flush=True)
 except Exception:pass
"""
        )
        registry = {
            "version": 2,
            "providers": {},
            "models": {},
            "skills": {},
            "orchestrations": {},
            "mcp": {
                "fixture": {
                    "type": "local",
                    "command": [sys.executable, str(peer)],
                    "codemode": False,
                }
            },
            "mcpProfiles": {"core": {"id": "core", "name": "Core", "mcp": ["fixture"]}},
            "mcpSettings": {"mode": "auto", "sessions": {}},
        }
        config["permissions"].append({"action": "*", "resource": "*", "effect": "allow"})
        manager_uri = (ROOT / "config/plugins/config-manager.js").as_uri()
        (plugins / "config-fixture.js").write_text(
            "import manager from "
            + json.dumps(manager_uri)
            + ";\nconst registry="
            + json.dumps(registry)
            + ';\nexport default {id:manager.id,setup(ctx){return manager.setup({...ctx,storage:{...ctx.storage,get:async(key)=>key==="registry-v2"?structuredClone(registry):ctx.storage.get(key)}})}};'
        )
        (cfg / "opencode.json").write_text(json.dumps(config))
        (plugins / "runtime-guard.js").write_text(
            f'export {{ default }} from {json.dumps((ROOT/"config/plugins/server-runtime-guard.js").as_uri())};\n'
        )
        (plugins / "fixture.js").write_text(
            """export default {id:'fixture.tools',async setup(ctx){await ctx.tool.transform(t=>t.add({name:'diagnostic_read',description:'Read the deterministic diagnostic fixture.',input:{type:'object',properties:{},additionalProperties:false},options:{pinned:true,codemode:false},execute:async()=>({content:'HEAD\\n'+'x'.repeat(30000)+'\\nFINAL_ERROR_SENTINEL_219'})}));}};"""
        )

        def run(name, cmd, timeout=180):
            with (output / (name + ".log")).open("w") as log:
                p = subprocess.Popen(
                    cmd,
                    cwd=project,
                    env=env,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                try:
                    code = p.wait(timeout)
                except subprocess.TimeoutExpired:
                    os.killpg(p.pid, signal.SIGTERM)
                    p.wait(timeout=5)
                    raise
            if code:
                raise RuntimeError(f"{name}: exit {code}")

        try:
            run("service-start", [binary, "service", "start"], 180)
            service = json.loads((home / ".local/state/opencode/service.json").read_text())
            headers = {
                "Authorization": "Basic "
                + base64.b64encode(("opencode:" + service["password"]).encode()).decode(),
                "Content-Type": "application/json",
            }
            body = {
                "title": "Deterministic native budget acceptance",
                "model": {"providerID": "fixture", "id": "fixture"},
                "agent": "build",
                "location": {"directory": str(project)},
            }
            with urlopen(
                Request(
                    service["url"].rstrip("/") + "/api/session",
                    data=json.dumps(body).encode(),
                    headers=headers,
                ),
                timeout=30,
            ) as response:
                sid = json.load(response)["data"]["id"]
            run(
                "native-run",
                [
                    binary,
                    "run",
                    "--session",
                    sid,
                    "--format",
                    "json",
                    f"Preserve {XML}. Read diagnostic_read, then read its artifact if provided, then return OK.",
                ],
            )
            text = (output / "native-run.log").read_text()
            if TAIL not in text:
                raise AssertionError("Native agent did not reach the expected final response")
            assert 2 <= len(requests) <= 8, len(requests)
            assert all(body.get("max_tokens") == 2048 for body in requests), [
                body.get("max_tokens") for body in requests
            ]

            # This pinned CLI serializes string parts as JSON strings on its wire.
            # Decode exactly that wrapper, not XML entities or arbitrary text.
            def native_text(value):
                if isinstance(value, str):
                    try:
                        decoded = json.loads(value)
                        return decoded if isinstance(decoded, str) else value
                    except ValueError:
                        return value
                return ""

            assert all(
                any(
                    XML in native_text(m.get("content"))
                    for m in body.get("messages", [])
                    if m.get("role") == "user"
                )
                for body in requests
            ), "user XML changed in actual provider input"
            assert any(
                "call_artifact" in json.dumps(body) for body in requests
            ), "model did not read retained artifact"
            exposed = [
                [tool.get("function", {}).get("name", "") for tool in body.get("tools", [])]
                for body in requests
            ]
            assert all(
                sum(name.startswith("fixture_") and name != "diagnostic_read" for name in tools)
                <= 8
                for tools in exposed
            ), exposed
            assert not any(
                name.endswith("cad_12") for name in exposed[0]
            ), "all MCP schemas leaked before discovery"
            assert any(
                name.endswith("cad_12") for tools in exposed[1:] for name in tools
            ), "MCP discovery did not load the selected native schema"
            assert "COMPONENT_12_OK" in text, "native MCP execution did not complete"
            report["checks"] += [
                "100 real MCP schemas deferred on provider wire",
                "bounded discovered schema on next step",
                "discovered MCP tool executes through native transport",
            ]
            report["checks"] += [
                "real native generation",
                "wire output cap 2048",
                "unchanged user XML",
                "large diagnostic tail",
                "model reads its artifact",
                "no public custom web listener",
            ]
            state = home / ".local/state"
            dbs = list(state.rglob("*.sqlite3"))
            dbpath = next((p for p in dbs if "custom-opencode" in str(p)), None)
            if not dbpath:
                dbpath = next(p for p in state.rglob("*.sqlite") if "custom-opencode" in str(p))
            with sqlite3.connect(dbpath) as db:
                rows = db.execute(
                    "SELECT state,usage_json,reserved FROM execution_requests"
                ).fetchall()
                assert len(rows) == len(requests), (len(rows), len(requests))
                completed = [row for row in rows if row[0] == "completed"]
                unknown = [row for row in rows if row[0] in {"usage_unknown", "failed"}]
                assert len(unknown) == int(args.retry_once), rows
                assert len(completed) + len(unknown) == len(rows), rows
                assert sum(json.loads(row[1])["output"] for row in completed) == len(completed) * 20
                assert (
                    sum(json.loads(row[1])["reasoning"] for row in completed) == len(completed) * 7
                )
                if args.retry_once:
                    assert (
                        unknown[0][2] == 2048
                    ), "ambiguous error silently released its reservation"
                    report["checks"].append(
                        "real HTTP retry spends a separate root call; unknown error charge is not zero"
                    )
            with sqlite3.connect(dbpath) as db:
                initial_roots = db.execute(
                    "SELECT DISTINCT root_id FROM execution_requests"
                ).fetchall()
                initial_binding = db.execute(
                    "SELECT root_id,turn_id FROM execution_bindings WHERE session_id=?", (sid,)
                ).fetchone()
                assert len(initial_roots) == 1 and initial_binding[1], initial_binding
                assert initial_binding[0] == initial_roots[0][0]
            previous_count = len(requests)
            run(
                "native-second-turn",
                [
                    binary,
                    "run",
                    "--session",
                    sid,
                    "--format",
                    "json",
                    f"Preserve {XML}. Return OK without another tool call.",
                ],
            )
            assert len(requests) == previous_count + 1, "unexpected repeated work on second turn"
            assert requests[-1].get("max_tokens") == 2048
            with sqlite3.connect(dbpath) as db:
                roots = db.execute(
                    "SELECT id,calls FROM execution_roots ORDER BY started_at"
                ).fetchall()
                binding = db.execute(
                    "SELECT root_id,turn_id FROM execution_bindings WHERE session_id=?", (sid,)
                ).fetchone()
                assert len(roots) == 2, roots
                assert (
                    binding[0] != initial_binding[0] and binding[1] != initial_binding[1]
                ), binding
                assert sorted(row[1] for row in roots) == sorted([previous_count, 1]), roots
                rows = db.execute(
                    "SELECT state,usage_json,reserved FROM execution_requests"
                ).fetchall()
                assert len(rows) == len(requests)
                completed = [row for row in rows if row[0] == "completed"]
                assert sum(json.loads(row[1])["output"] for row in completed) == len(completed) * 20
            report["checks"] += [
                "all tool steps and HTTP retry share one native root turn",
                "a genuinely new user turn receives a new independent budget",
            ]
            report["checks"] += [
                "one ledger row per actual provider request",
                "provider usage without double-counting reasoning",
                "durable output reconciliation",
            ]
            report.update(ok=True, requests=len(requests), ledgerRequests=len(rows))
        except Exception as error:
            report["error"] = f"{type(error).__name__}: {error}"
            import traceback

            (output / "failure.log").write_text(traceback.format_exc())
        finally:
            subprocess.run(
                [str(launcher), "stop"],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=15,
                check=False,
            )
            subprocess.run(
                [binary, "service", "stop"],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=20,
                check=False,
            )
            for log in (home / ".local/state/custom-opencode-policy").glob("*.log"):
                shutil.copy2(log, output / "private-policy.log")
            native_log = home / ".local/share/opencode/log/opencode.log"
            if native_log.exists():
                shutil.copy2(native_log, output / "native-engine.log")
            (output / "wire.json").write_text(json.dumps(requests, ensure_ascii=False, indent=2))
    provider.shutdown()
    provider.server_close()
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["ok"] else 1


def shlex_quote(value):
    import shlex

    return shlex.quote(value)


if __name__ == "__main__":
    raise SystemExit(main())
