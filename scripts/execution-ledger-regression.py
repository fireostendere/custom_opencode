#!/usr/bin/env python3
"""Atomic native/child/retry budget and private-worker acceptance, no inference."""
import json
import os
from pathlib import Path
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))
from execution_ledger import ExecutionLedger, BudgetExceeded
from runtime_store import RuntimeStore
from runtime_lease import WorkerLease
from repo_services import ArtifactStore


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict(
            os.environ,
            {
                "OPENCODE_ROOT_BUDGET_JSON": json.dumps(
                    {
                        "calls": 3,
                        "outputTokens": 1000,
                        "toolAttempts": 3,
                        "seconds": 60,
                        "finishTokens": 100,
                    }
                )
            },
        )
        self.env.start()
        self.addCleanup(self.env.stop)
        self.store = RuntimeStore(Path(self.tmp.name) / "state.sqlite3")
        self.ledger = ExecutionLedger(self.store)
        self.root = self.ledger.bind(
            session_id="root",
            turn_id="turn1",
            parent_id=None,
            directory=self.tmp.name,
            model_ref="provider/model",
        )

    def bind(self, sid, parent="root"):
        return self.ledger.bind(
            session_id=sid,
            turn_id="child-turn",
            parent_id=parent,
            directory=self.tmp.name,
            model_ref="provider/reader",
        )

    def test_nested_reader_builder_repair_review_one_root(self):
        for child, parent in [
            ("reader", "root"),
            ("builder", "reader"),
            ("repair", "builder"),
            ("review", "repair"),
        ]:
            self.assertEqual(self.bind(child, parent)["rootID"], self.root["rootID"])
        for n, sid in enumerate(["reader", "builder", "repair"]):
            self.ledger.reserve(sid, f"req{n}", output_limit=200)
        with self.assertRaises(BudgetExceeded):
            self.ledger.reserve("review", "extra", output_limit=200)
        self.assertIsNotNone(self.store.cache_get("native-budget-checkpoint", self.root["rootID"]))
        self.assertEqual(
            self.ledger.reserve("root", "finish", output_limit=100, finish=True)["maxOutputTokens"],
            100,
        )
        with self.assertRaises(BudgetExceeded):
            self.ledger.tool("review")
        with self.assertRaises(BudgetExceeded):
            self.ledger.reserve("root", "finish-again", output_limit=100, finish=True)

    def test_reservations_not_usage_and_idempotency(self):
        self.ledger.reserve("root", "one", output_limit=400)
        self.ledger.reserve("root", "one", output_limit=400)
        self.assertEqual(self.ledger.snapshot("root")["calls"], 1)
        self.assertEqual(self.ledger.summary()["usageUnknownRequests"], 1)
        self.ledger.finish(
            "root",
            "one",
            usage={"input": 90, "output": 40, "reasoning": 30, "cacheRead": 20},
            status=200,
        )
        self.ledger.finish("root", "one", usage={"input": 900, "output": 400}, status=200)
        self.assertEqual(self.ledger.snapshot("root")["output_reserved"], 40)
        self.assertEqual(self.ledger.summary()["knownUsage"]["output"], 40)
        self.assertIsNone(self.ledger.summary()["cost"])

    def test_unknown_provider_error_retains_reservation_and_retry_spends_call(self):
        self.ledger.reserve("root", "fail", output_limit=400)
        self.ledger.finish("root", "fail", usage=None, status=503, error="transient")
        self.ledger.reserve("root", "retry", output_limit=400)
        self.assertEqual(self.ledger.snapshot("root")["calls"], 2)
        self.assertEqual(self.ledger.snapshot("root")["output_reserved"], 800)

    def test_concurrent_atomic_limits(self):
        def reserve(i):
            try:
                self.ledger.reserve("root", str(i), output_limit=20)
                return 1
            except BudgetExceeded:
                return 0

        with ThreadPoolExecutor(max_workers=20) as pool:
            self.assertEqual(sum(pool.map(reserve, range(20))), 3)

    def test_no_borrowing_by_cwd_or_unbound_parent(self):
        with self.assertRaises(PermissionError):
            self.bind("child", "nonexistent")
        other = self.ledger.bind(
            session_id="neighbor",
            turn_id="a",
            parent_id=None,
            directory=self.tmp.name,
            model_ref="provider/model",
        )
        self.assertNotEqual(other["rootID"], self.root["rootID"])
        self.ledger.reserve("root", "owned", output_limit=100)
        with self.assertRaises(PermissionError):
            self.ledger.finish("neighbor", "owned", usage={"output": 0}, status=200)

    def test_new_turn_new_root_but_live_child_retains_old_root(self):
        self.bind("child")
        nextroot = self.ledger.bind(
            session_id="root",
            turn_id="turn2",
            parent_id=None,
            directory=self.tmp.name,
            model_ref="provider/model2",
        )
        self.assertNotEqual(nextroot["rootID"], self.root["rootID"])
        self.assertEqual(self.bind("child")["rootID"], self.root["rootID"])

    def test_tool_and_time_limits(self):
        self.bind("child")
        for _ in range(3):
            self.ledger.tool("child")
        with self.assertRaises(BudgetExceeded):
            self.ledger.tool("root")
        with patch("execution_ledger.now_ms", return_value=self.root["started_at"] + 61000):
            with self.assertRaises(BudgetExceeded):
                self.ledger.reserve("root", "late", output_limit=100)

    def test_review_same_change_has_one_owner(self):
        self.assertTrue(self.ledger.claim_review(self.root["rootID"], "diff", "orchestrator"))
        self.assertFalse(self.ledger.claim_review(self.root["rootID"], "diff", "server"))
        self.assertTrue(self.ledger.claim_review(self.root["rootID"], "new-diff", "server"))

    def test_worker_exclusivity_and_handover(self):
        one = WorkerLease(Path(self.tmp.name))
        two = WorkerLease(Path(self.tmp.name))
        try:
            self.assertTrue(one.acquire())
            self.assertFalse(two.acquire())
            one.release()
            self.assertTrue(two.acquire())
        finally:
            one.release()
            two.release()

    def test_native_artifact_owned_and_search_bounded(self):
        artifacts = ArtifactStore(self.store)
        artifact = artifacts.put(
            task_id=None,
            project_dir=self.tmp.name,
            owner_session="root",
            kind="test",
            title="large",
            content="error " + "x" * 30000,
        )
        with self.assertRaises(PermissionError):
            artifacts.get(artifact["id"], session_id="neighbor")
        result = artifacts.get(artifact["id"], session_id="root", query="error", limit=100)
        self.assertLessEqual(sum(len(item["context"]) for item in result["content"]), 100)

    def test_invalid_limits_fail_closed(self):
        with patch.dict(os.environ, {"OPENCODE_ROOT_BUDGET_JSON": '{"calls":0}'}):
            with self.assertRaises(ValueError):
                self.ledger.limits()


if __name__ == "__main__":
    unittest.main(verbosity=2)
