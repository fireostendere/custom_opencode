#!/usr/bin/env python3
"""Offline behavioral acceptance for audit fixes; no provider inference."""
from __future__ import annotations
import ast
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HOME = tempfile.TemporaryDirectory(prefix="audit-fixes-home-")
os.environ.update(HOME=HOME.name, XDG_STATE_HOME=HOME.name, OPENCODE_REPO_EMBEDDINGS="hash")
sys.path.insert(0, str(ROOT / "app"))
import runtime_v3
import runtime_store
import server_runtime
from runtime_store import RuntimeStore
from runtime_v3 import DynamicContextManager, ToolGateway, _hash_embedding, _resolve_relative_import
from repo_services import ArtifactStore, classify_failure


class Registry:
    def __init__(self, limit=128000, ratio=0.72):
        self.limit, self.ratio = limit, ratio

    def profiles(self):
        return {"direct": {"contextPolicy": {"targetRatio": self.ratio}}}

    def get(self, ref):
        return {"context": self.limit}


class Fixes(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="audit-fix-")
        self.addCleanup(self.temp.cleanup)
        self.store = RuntimeStore(Path(self.temp.name) / "runtime.sqlite3")
        self.ctx = DynamicContextManager(self.store, None, None)
        self.task = self.store.create_task(
            session_id="s",
            project_dir=self.temp.name,
            text="fix voltage",
            metadata={"sandbox": "repo-write"},
            route={"selectedModel": "fixture/model"},
        )

    def gateway(self):
        self.store.claim_dispatch(self.task["id"])
        artifacts = ArtifactStore(self.store)
        sandbox = SimpleNamespace(normalize=lambda s: s, path_allowed=lambda *a, **k: True)
        return ToolGateway(self.store, artifacts, sandbox, None)

    def test_model_windows_no_hidden_cap(self):
        for size in (24576, 32768, 128000, 400000, 983616):
            with self.subTest(size=size):
                budget, reserve, limit, _, _ = self.ctx._budget(
                    SimpleNamespace(REGISTRY=Registry(size)), self.task
                )
                self.assertEqual(budget, int(size * 0.72))
                self.assertLessEqual(budget + reserve, limit)

    def test_budget_ratio_and_explicit_cap(self):
        low = self.ctx._budget(SimpleNamespace(REGISTRY=Registry(400000, 0.4)), self.task)[0]
        high = self.ctx._budget(SimpleNamespace(REGISTRY=Registry(400000, 0.8)), self.task)[0]
        self.assertGreater(high, low)
        registry = Registry()
        registry.profiles = lambda: {"direct": {"contextPolicy": {"maxInputTokens": 20000}}}
        self.assertEqual(self.ctx._budget(SimpleNamespace(REGISTRY=registry), self.task)[0], 20000)

    def test_unmanaged_uses_authoritative_native_model(self):
        runtime = SimpleNamespace(
            _model_ref=server_runtime._model_ref, capability_snapshot=lambda *a: None
        )
        features = SimpleNamespace(
            _session_info=lambda sid: {"model": {"providerID": "fixture", "id": "small"}},
            _session_directory=lambda s: self.temp.name,
        )
        task = self.ctx._session_task(features, runtime, "s", None)
        self.assertEqual(task["route"]["selectedModel"], "fixture/small")
        features._session_info = lambda sid: {"model": {"providerID": "fixture", "id": "large"}}
        self.assertEqual(
            self.ctx._session_task(features, runtime, "s", task)["route"]["selectedModel"],
            "fixture/large",
        )

    def test_native_model_switch_uses_request_local_catalog(self):
        from native_context import NativeContextFeatures
        from model_registry import CapabilityRegistry

        registry = CapabilityRegistry([])
        runtime = SimpleNamespace(
            REGISTRY=registry,
            _model_ref=server_runtime._model_ref,
            capability_snapshot=lambda *a: self.fail(
                "Native single-model snapshot must not replace shared catalog"
            ),
        )
        for limit in (24576, 983616, 24576):
            features = NativeContextFeatures(
                SimpleNamespace(),
                {
                    "sessionID": "s",
                    "directory": self.temp.name,
                    "model": {"providerID": "fixture", "id": "changing"},
                    "modelRecord": {
                        "providerID": "fixture",
                        "id": "changing",
                        "limit": {"context": limit, "output": 4096},
                    },
                },
            )
            task = self.ctx._session_task(features, runtime, "s", None)
            self.assertEqual(self.ctx._budget(runtime, task)[2], limit)
        self.assertEqual(registry.models(), [])

    def test_rejected_compact_retries_without_growth(self):
        class Failure(Exception):
            status = 503

        features = SimpleNamespace(
            _backend_request_json=lambda *a, **kw: (_ for _ in ()).throw(Failure())
        )
        runtime = SimpleNamespace(REGISTRY=Registry(32768))
        with (
            patch.object(self.ctx, "_active_tokens", return_value=(30000, [])),
            patch.object(runtime_v3, "now_ms", return_value=100000),
        ):
            first = self.ctx.maybe_compact(features, runtime, "s", self.task)
        self.assertFalse(first["compactionRequested"])
        self.assertIsNone(
            self.store.cache_get("context-compaction-state", "s").get("lastRequestTokens")
        )
        features._backend_request_json = lambda *a, **kw: {"ok": True}
        with (
            patch.object(self.ctx, "_active_tokens", return_value=(30000, [])),
            patch.object(runtime_v3, "now_ms", return_value=106000),
        ):
            self.assertTrue(
                self.ctx.maybe_compact(features, runtime, "s", self.task)["compactionRequested"]
            )

    def test_ambiguous_compact_not_duplicated(self):
        calls = []

        def timeout(*a, **kw):
            calls.append(a)
            raise TimeoutError()

        features = SimpleNamespace(_backend_request_json=timeout)
        with patch.object(self.ctx, "_active_tokens", return_value=(30000, [])):
            self.ctx.maybe_compact(
                features, SimpleNamespace(REGISTRY=Registry(32768)), "s", self.task
            )
            self.ctx.maybe_compact(
                features, SimpleNamespace(REGISTRY=Registry(32768)), "s", self.task
            )
        self.assertEqual(len(calls), 1)

    def test_queue_baseline_and_capture_idempotency(self):
        current = {"input": 200, "output": 20, "cost": 2.0, "available": True}
        features = SimpleNamespace(_send_backend_prompt=lambda *a: {"accepted": True})
        with (
            patch.object(server_runtime, "STORE", self.store),
            patch.object(server_runtime, "_switch_session", return_value={}),
            patch.object(server_runtime, "_usage_totals", side_effect=lambda *a: dict(current)),
        ):
            server_runtime._dispatch_task(features, self.task)
            current.update(input=250, output=25, cost=2.5)
            server_runtime._capture_usage(features, self.task, True)
            server_runtime._capture_usage(features, self.task, True)
        total = self.store.usage_summary(self.task["id"])["total"]
        self.assertEqual(total["inputTokens"], 50)
        self.assertEqual(total["cost"], 0.5)

    def test_usage_pages_and_overlap(self):
        rows = [{"info": {"id": str(n), "tokens": {"input": 1}}} for n in range(350)]

        def get(method, path, **kw):
            return (
                {"data": rows[199:], "cursor": {}}
                if "cursor=" in path
                else {"data": rows[:200], "cursor": {"next": "p2"}}
            )

        features = SimpleNamespace(_backend_request_json=get, _data=lambda x: x["data"])
        result = server_runtime._usage_totals(features, "s")
        self.assertTrue(result["available"])
        self.assertEqual(result["input"], 350)

    def test_usage_failure_is_not_zero_usage(self):
        features = SimpleNamespace(
            _backend_request_json=lambda *a, **kw: (_ for _ in ()).throw(OSError("offline"))
        )
        self.assertFalse(server_runtime._usage_totals(features, "s")["available"])

    def test_tail_and_duplicate_preserve_diagnostic(self):
        gateway = self.gateway()
        text = "x" * 30000 + "\nERROR_SENTINEL_AT_TAIL"
        first = gateway.after({"sessionID": "s", "tool": "bash", "result": text})["result"]
        second = gateway.after({"sessionID": "s", "tool": "bash", "result": text})["result"]
        self.assertIn("ERROR_SENTINEL_AT_TAIL", first["preview"])
        self.assertIn("ERROR_SENTINEL_AT_TAIL", second["preview"])
        self.assertEqual(first["artifactID"], second["artifactID"])
        result = gateway.read_artifact(
            {"sessionID": "s", "artifactID": first["artifactID"], "offset": 29000}
        )
        self.assertIn("ERROR_SENTINEL_AT_TAIL", result["content"])
        with self.assertRaises(PermissionError):
            gateway.read_artifact({"sessionID": "other", "artifactID": first["artifactID"]})

    def test_polling_allowed_but_repeated_write_denied(self):
        gateway = self.gateway()
        for name in ("fabric_job_status", "fabric_fabric_job_status", "fabric_fabric_job_result"):
            for _ in range(10):
                gateway.before({"sessionID": "s", "tool": name, "input": {"jobId": "j"}})
        for _ in range(2):
            gateway.before({"sessionID": "s", "tool": "write", "input": {}})
        with self.assertRaises(RuntimeError):
            gateway.before({"sessionID": "s", "tool": "write", "input": {}})

    def test_real_sliding_rate_window(self):
        gateway = self.gateway()
        with patch.dict(os.environ, {"OPENCODE_MCP_RATE_LIMIT": "5"}):
            for n in range(20):
                with patch.object(runtime_store, "now_ms", return_value=1000000 + n * 30000):
                    gateway._rate(self.task["id"], "fabric_job_status")
            with patch.object(runtime_store, "now_ms", return_value=2000000):
                for _ in range(5):
                    gateway._rate(self.task["id"], "fabric_job_status")
                with self.assertRaises(RuntimeError) as e:
                    gateway._rate(self.task["id"], "fabric_job_status")
                self.assertEqual(e.exception.retry_after, 60)

    def test_rate_atomic_across_workers(self):
        self.store.initialize()

        def consume(n):
            try:
                RuntimeStore(self.store.paths.db).consume_rate("one", 5)
                return True
            except RuntimeError:
                return False

        with ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(sum(pool.map(consume, range(20))), 5)

    def test_evidence_survives_large_memory(self):
        self.store.claim_dispatch(self.task["id"])
        self.ctx.indexer = SimpleNamespace(
            search=lambda *a, **kw: {"hits": [{"qualified": "CURRENT_SYMBOL"}]},
            semantic_diff=lambda *a: {},
        )
        self.ctx.rag = SimpleNamespace(search=lambda *a: {"context": "CRITICAL_RAG"})
        runtime = SimpleNamespace(
            CONTEXT=SimpleNamespace(envelope=lambda **k: {"text": "M" * 26000})
        )
        features = SimpleNamespace(_session_directory=lambda *a: self.temp.name)
        with patch.object(self.ctx, "maybe_compact", return_value={"budgetTokens": 48000}):
            result = self.ctx.envelope(features, runtime, "s", "MANDATORY_POLICY", rag_mode="on")
        for value in ("CURRENT_SYMBOL", "CRITICAL_RAG", "MANDATORY_POLICY"):
            self.assertIn(value, result["text"])
        self.assertLessEqual(len(result["text"]), 24000)

    def test_relative_import_containment_and_unicode(self):
        files = {"src/util.ts", "src/deep/main.ts", "src/pkg/index.ts", "outside.ts"}
        self.assertEqual(
            _resolve_relative_import("src/deep/main.ts", "../util", files), "src/util.ts"
        )
        self.assertEqual(
            _resolve_relative_import("src/main.ts", "./pkg", files), "src/pkg/index.ts"
        )
        self.assertIsNone(_resolve_relative_import("src/main.ts", "../../outside", files))
        self.assertGreater(sum(abs(x) for x in _hash_embedding("исправь схему питания")), 0)
        self.assertEqual(
            _resolve_relative_import("pkg/sub/main.py", "..util", {"pkg/util.py"}), "pkg/util.py"
        )
        self.assertEqual(
            _resolve_relative_import("pkg/main.py", ".util", {"pkg/util.py"}), "pkg/util.py"
        )
        self.assertIsNone(_resolve_relative_import("pkg/main.py", "...secret", {"secret.py"}))

    def test_environment_not_actionable_code(self):
        for text, code, expected in [
            ("npm: command not found", 127, "executable_missing"),
            ("Could not resolve host", 1, "dependency_unavailable"),
            ("bwrap: Operation not permitted", 1, "sandbox_denied"),
            ("verification timeout", 124, "timeout"),
            ("AssertionError: expected true", 1, "code"),
            ("unrecognized failure", 1, "unknown"),
        ]:
            with self.subTest(text=text):
                self.assertEqual(classify_failure(text, code), expected)

    def test_web_request_preserves_user_and_no_blind_fallback(self):
        tree = ast.parse((ROOT / "app/server_workflow.py").read_text())
        node = next(
            n
            for n in tree.body
            if isinstance(n, ast.FunctionDef) and n.name == "_send_with_project_context"
        )

        class HTTPError(Exception):
            def __init__(self, status):
                self.status = status

        sent = []
        fallback = []
        features = SimpleNamespace(
            _session_directory=lambda s: self.temp.name,
            project_settings=lambda d: {"instructions": "POLICY"},
            BackendHTTPError=HTTPError,
        )
        features._backend_request_json = lambda method, path, body, **kw: sent.append(body)
        ns = {
            "features": features,
            "runtime": SimpleNamespace(STORE=None),
            "runtime_resume": SimpleNamespace(continuation_payload=lambda *a: (a[2], [], None)),
            "quote": lambda s, **kw: s,
            "_file_parts": lambda x: [],
            "_ORIGINAL_SEND": lambda *a: fallback.append(a),
        }
        exec(compile(ast.Module(body=[node], type_ignores=[]), "web-function", "exec"), ns)
        for _ in range(50):
            ns["_send_with_project_context"]("s", "user text", [])
        self.assertTrue(
            all(body == {"parts": [{"type": "text", "text": "user text"}]} for body in sent)
        )
        for status in (400, 401, 422, 500):
            features._backend_request_json = lambda *a, **kw: (_ for _ in ()).throw(
                HTTPError(status)
            )
            with self.assertRaises(HTTPError):
                ns["_send_with_project_context"]("s", "user text", [])
        self.assertEqual(fallback, [])
        features._backend_request_json = lambda *a, **kw: (_ for _ in ()).throw(HTTPError(404))
        ns["_send_with_project_context"]("s", "user text", [])
        self.assertEqual(fallback, [("s", "user text", [])])


if __name__ == "__main__":
    unittest.main(verbosity=2)
