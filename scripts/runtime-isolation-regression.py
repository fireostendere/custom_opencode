#!/usr/bin/env python3
"""Executable regressions for concurrent dispatch, ownership and shell boundaries."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))
from repo_services import ArtifactStore
from runtime_store import RuntimeStore
from runtime_v3 import SandboxManager, ScopedSecretBroker, ToolGateway


class RuntimeIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / "repo"
        self.project.mkdir()
        self.store = RuntimeStore(self.root / "state" / "runtime.sqlite3")
        self.store.initialize()
        self.sandbox = SandboxManager()
        self.gateway = ToolGateway(self.store, ArtifactStore(self.store), self.sandbox, ScopedSecretBroker())

    def task(self, session="session", **kwargs):
        return self.store.create_task(session_id=session, project_dir=str(self.project), **kwargs)

    def owners(self):
        with self.store.connect() as db:
            return {(r[0], r[1]) for r in db.execute("SELECT path,task_id FROM patch_ownership")}

    def test_parallel_dispatch_has_one_session_owner(self):
        tasks = [self.task() for _ in range(12)]
        barrier = threading.Barrier(len(tasks))
        def claim(task):
            # Separate store instances model concurrent HTTP handlers/processes.
            store = RuntimeStore(self.store.paths.db)
            store.initialize()
            barrier.wait(timeout=10)
            return store.claim_dispatch(task["id"])
        with ThreadPoolExecutor(max_workers=len(tasks)) as pool:
            claimed = list(pool.map(claim, tasks))
        self.assertEqual(sum(row is not None for row in claimed), 1)
        self.assertEqual(len(self.store.list_tasks(states=["queued"])), 11)

    def test_separate_sessions_still_run_in_parallel(self):
        for session in ("one", "two"):
            self.assertIsNotNone(self.store.claim_dispatch(self.task(session)["id"]))

    def test_terminal_owner_releases_session(self):
        first, second = self.task(), self.task()
        self.assertIsNotNone(self.store.claim_dispatch(first["id"]))
        self.assertIsNone(self.store.claim_dispatch(second["id"]))
        self.store.transition(first["id"], "completed")
        self.assertIsNotNone(self.store.claim_dispatch(second["id"]))

    def test_recovering_session_cannot_be_taken_over(self):
        first, second = self.task(), self.task()
        self.store.transition(first["id"], "recovering")
        self.assertIsNone(self.store.claim_dispatch(second["id"]))

    def test_dependencies_remain_a_dispatch_gate(self):
        dependency = self.task("dependency")
        waiting = self.task(dependencies=[dependency["id"]])
        self.assertIsNone(self.store.claim_dispatch(waiting["id"]))
        self.store.transition(dependency["id"], "completed")
        self.assertIsNotNone(self.store.claim_dispatch(waiting["id"]))

    def test_rejected_owner_does_not_poison_lock(self):
        first, second = self.task("one"), self.task("two")
        self.assertEqual(self.store.ownership_replace(str(self.project), first["id"], ["a.py"]), [])
        conflicts = self.store.ownership_replace(str(self.project), second["id"], ["a.py"])
        self.assertEqual(conflicts, [{"path": "a.py", "taskID": first["id"]}])
        self.assertEqual(self.owners(), {("a.py", first["id"])})
        self.assertEqual(self.store.ownership_replace(str(self.project), first["id"], ["a.py"]), [])

    def test_multi_file_claim_is_all_or_nothing(self):
        first, second = self.task("one"), self.task("two")
        self.store.ownership_replace(str(self.project), first["id"], ["locked.py"])
        self.store.ownership_replace(str(self.project), second["id"], ["existing.py"])
        self.assertTrue(self.store.ownership_replace(str(self.project), second["id"], ["free.py", "locked.py"]))
        self.assertEqual(self.owners(), {("locked.py", first["id"]), ("existing.py", second["id"])})

    def test_terminal_owner_releases_files(self):
        first, second = self.task("one"), self.task("two")
        self.store.ownership_replace(str(self.project), first["id"], ["a.py"])
        self.store.transition(first["id"], "failed")
        self.assertEqual(self.store.ownership_replace(str(self.project), second["id"], ["a.py"]), [])

    def test_explicit_session_never_uses_another_session_task(self):
        active = self.task("managed", metadata={"sandbox": "full-machine"})
        self.store.transition(active["id"], "running")
        self.assertIsNone(self.gateway._task("unrelated", str(self.project)))

    def test_ambiguous_directory_does_not_choose_arbitrary_task(self):
        for session in ("one", "two"):
            self.store.transition(self.task(session)["id"], "running")
        with self.assertRaises(PermissionError):
            self.gateway._task(None, str(self.project))

    def test_queued_task_does_not_own_native_session(self):
        self.task()
        self.assertIsNone(self.gateway._task("session", str(self.project)))

    def test_shell_cwd_cannot_leave_task_project(self):
        self.store.transition(self.task()["id"], "running")
        outside = self.root / "outside"
        outside.mkdir()
        with patch.object(self.sandbox, "wrap_shell", return_value={}) as wrap:
            with self.assertRaises(PermissionError):
                self.gateway.shell({"sessionID": "session", "cwd": str(outside), "command": "pwd"})
            wrap.assert_not_called()

    def test_shell_cwd_symlink_escape_is_rejected(self):
        self.store.transition(self.task()["id"], "running")
        (self.project / "escape").symlink_to(self.root, target_is_directory=True)
        with patch.object(self.sandbox, "wrap_shell", return_value={}):
            with self.assertRaises(PermissionError):
                self.gateway.shell({"sessionID": "session", "cwd": str(self.project / "escape"), "command": "pwd"})

    def test_relative_shell_cwd_uses_task_root(self):
        self.store.transition(self.task()["id"], "running")
        nested = self.project / "src"
        nested.mkdir()
        with patch.object(self.sandbox, "wrap_shell", return_value={}) as wrap:
            self.gateway.shell({"sessionID": "session", "cwd": "src", "command": "pwd"})
            self.assertEqual(wrap.call_args.args[1], str(nested))

    def test_move_patch_validates_destination(self):
        self.store.transition(self.task()["id"], "running")
        with self.assertRaises(PermissionError):
            self.gateway.before({"sessionID": "session", "tool": "apply_patch", "input": {
                "patchText": "*** Begin Patch\n*** Update File: a.py\n*** Move to: ../outside.py\n@@\n-old\n+new\n*** End Patch"
            }})


if __name__ == "__main__":
    unittest.main(verbosity=2)
