#!/usr/bin/env python3
"""Runtime performance/resource regressions (no network, no model calls).

Covers: list projections that never decode attachments, single-read and
no-op-skipping task mutations, worker-lease-only maintenance with durable
notifications and replay capture, write-on-change monitor heartbeats, the
stale-while-rebuild semantic index, cached semantic diffs, byte-stable context
envelopes, gzip replays, and extended pruning/WAL compaction.
"""
from __future__ import annotations

import gzip
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))
os.environ.setdefault("OPENCODE_REPO_EMBEDDINGS", "hash")

from repo_services import ArtifactStore, git_snapshot, invalidate_git_snapshot  # noqa: E402
from runtime_store import RuntimeStore, now_ms  # noqa: E402

ATTACHMENT = "data:image/png;base64," + "A" * 400_000


def git(project: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(project), *args], check=True, capture_output=True)


def make_repo(root: Path, name: str = "project") -> Path:
    project = root / name
    project.mkdir()
    git(project, "init", "-q")
    git(project, "config", "user.email", "perf@example.invalid")
    git(project, "config", "user.name", "Perf Regression")
    (project / "core.py").write_text("class Engine:\n    def alpha(self):\n        return 1\n", encoding="utf-8")
    (project / "util.js").write_text("export function helper() { return 2 }\n", encoding="utf-8")
    git(project, "add", ".")
    git(project, "commit", "-qm", "base")
    return project


class StoreProjectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = RuntimeStore(Path(self.tmp.name) / "state" / "runtime.sqlite3")
        self.store.initialize()

    def _tasks(self):
        files = [
            {"name": "photo.png", "uri": ATTACHMENT, "mime": "image/png"},
            {"uri": "data:text/plain;base64,QQ=="},
            {"name": True},
            {},
            "not-a-dict",
        ]
        a = self.store.create_task(
            session_id="s1", project_dir="/p", text="x" * 1500, files=files,
            metadata={"sandbox": "safe", "worktree": {"path": "/w"}, "big": ["y"] * 100},
            route={"selectedModel": "m"}, baseline={"head": "abc"},
        )
        b = self.store.create_task(session_id="s2", project_dir="/p", text="b", dependencies=[a["id"]])
        return a, b

    def test_projections_match_full_rows(self):
        import server_runtime

        self._tasks()
        full = {row["id"]: row for row in self.store.list_tasks(limit=50)}
        for json_sql in (True, False):  # JSON1 path and the pure-Python fallback
            self.store._json_sql = json_sql
            for projection in ("public", "summary", "light"):
                rows = self.store.list_tasks(limit=50, projection=projection)
                self.assertEqual([row["id"] for row in rows], list(full))
                for row in rows:
                    self.assertNotIn("files", row, "projections must never carry attachments")
                    reference = full[row["id"]]
                    self.assertEqual(row["dependencies"], reference["dependencies"])
                    if projection != "light":
                        self.assertEqual(server_runtime._public(row), server_runtime._public(reference))
                    if projection == "summary":
                        for key in ("metadata", "baseline", "route", "verification", "text"):
                            self.assertEqual(row[key], reference[key])
            one = self.store.get_task(next(iter(full)), projection="public")
            self.assertEqual(server_runtime._public(one), server_runtime._public(full[one["id"]]))
        self.assertEqual(
            server_runtime._public(full[next(iter(full))])["files"], ["photo.png", "file", "True", "file"]
        )

    def test_legacy_rows_without_denormalized_names(self):
        import server_runtime

        a, _ = self._tasks()
        expected = server_runtime._public(self.store.get_task(a["id"]))
        with self.store.transaction() as db:  # row written by an older runtime
            db.execute("UPDATE tasks SET file_names_json=NULL")
        for json_sql in (True, False):
            self.store._json_sql = json_sql
            row = self.store.get_task(a["id"], projection="public")
            self.assertEqual(server_runtime._public(row), expected)
        self.assertNotIn("file_names_json", self.store.get_task(a["id"]))
        self.assertEqual(self.store.prune()["fileNamesBackfilled"], 2)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM tasks WHERE file_names_json IS NULL").fetchone()[0], 0)
        self.assertEqual(server_runtime._public(self.store.get_task(a["id"], projection="public")), expected)

    def test_update_and_transition_single_read_and_noop(self):
        a, _ = self._tasks()
        before = self.store.get_task(a["id"])
        events = len(self.store.events(task_id=a["id"]))
        with self.store.connect() as db:
            changes = db.total_changes
        time.sleep(0.005)
        same = self.store.update_task(a["id"], metadata_patch={"sandbox": "safe"}, priority=0)
        self.assertEqual(same, before, "a no-op patch must not rewrite the row")
        with self.store.connect() as db:
            self.assertEqual(db.total_changes, changes)
        self.assertEqual(len(self.store.events(task_id=a["id"])), events)
        changed = self.store.update_task(a["id"], metadata_patch={"backendObservedBusy": True})
        self.assertGreater(changed["updated_at"], before["updated_at"])
        self.assertEqual(changed, self.store.get_task(a["id"]))
        moved = self.store.transition(a["id"], "submitted", error="boom")
        self.assertEqual(moved, self.store.get_task(a["id"]))
        self.assertEqual(moved["files"][0]["uri"], ATTACHMENT, "full rows keep the payload")
        self.assertTrue(self.store.has_tasks(states={"submitted"}, session_id="s1"))
        self.assertFalse(self.store.has_tasks(states={"running"}))
        self.assertEqual(self.store.task_state(a["id"]), "submitted")
        self.assertEqual(self.store.task_states([a["id"], "missing"]), {a["id"]: "submitted"})

    def test_checkpoint_keep_prune_and_compact(self):
        a, _ = self._tasks()
        for index in range(30):
            self.store.checkpoint(a["id"], "progress", summary=str(index), keep=5)
        progress = [cp for cp in self.store.checkpoints(a["id"]) if cp["stage"] == "progress"]
        self.assertEqual([cp["summary"] for cp in progress], ["29", "28", "27", "26", "25"])
        # Legacy rows beyond the cap are trimmed by prune().
        with self.store.transaction() as db:
            for index in range(30):
                db.execute(
                    "INSERT INTO checkpoints(id,task_id,stage,summary,data_json,created_at) VALUES(?,?,?,?,?,?)",
                    (f"old{index}", a["id"], "progress", "old", "{}", index),
                )
        artifacts = ArtifactStore(self.store)
        old = now_ms() - 10 * 86_400_000
        kept = artifacts.put(task_id=a["id"], project_dir="/p", kind="verification-log", title="log", content="v" * 30000)
        replay = artifacts.put(task_id=a["id"], project_dir="/p", kind="run-replay", title="r", content="[]", mime="application/json", compress=True)
        shared = artifacts.put(task_id=None, project_dir="/p", kind="tool-output", title="t", content="t" * 30000)
        fresh = artifacts.put(task_id=None, project_dir="/p", kind="tool-output", title="t2", content="u" * 30000)
        with self.store.transaction() as db:
            db.execute("UPDATE artifacts SET created_at=? WHERE id IN (?,?,?)", (old, kept["id"], replay["id"], shared["id"]))
        from execution_ledger import ExecutionLedger

        ExecutionLedger(self.store)
        stale, recent = now_ms() - 40 * 86_400_000, now_ms()
        with self.store.transaction() as db:
            for root, started in (("root-old", stale), ("root-new", recent), ("root-busy", stale)):
                db.execute("INSERT INTO execution_roots(id,session_id,started_at,limits_json) VALUES(?,?,?,?)", (root, root, started, "{}"))
                db.execute("INSERT INTO execution_bindings VALUES(?,?,?,?,?,?,?)", (root, root, "t", None, None, "/p", None))
            db.execute("INSERT INTO execution_requests(id,root_id,session_id,started_at,state,reserved) VALUES('q-old','root-old','root-old',?,'completed',1)", (stale,))
            db.execute("INSERT INTO execution_requests(id,root_id,session_id,started_at,state,reserved) VALUES('q-busy','root-busy','root-busy',?,'completed',1)", (recent,))
        result = self.store.prune(retention_days=30)
        self.assertEqual(result["regenerableArtifacts"], 2)
        self.assertEqual(result["progressCheckpoints"], 35 - 20)
        self.assertEqual(result["executionRoots"], 1)
        self.assertEqual(result["executionBindings"], 1)
        self.assertEqual(result["executionRequests"], 1)
        self.assertIn("walCheckpoint", self.store.compact())
        with self.store.connect() as db:
            left = {row[0] for row in db.execute("SELECT id FROM artifacts")}
            roots = {row[0] for row in db.execute("SELECT id FROM execution_roots")}
            limit = db.execute("PRAGMA journal_size_limit").fetchone()[0]
        self.assertEqual(left, {kept["id"], fresh["id"]}, "only regenerable artifacts expire early")
        self.assertEqual(roots, {"root-new", "root-busy"})
        self.assertEqual(limit, 16 * 1024 * 1024)
        self.assertEqual(len([cp for cp in self.store.checkpoints(a["id"], limit=500) if cp["stage"] == "progress"]), 20)

    def test_db_maintenance_command_is_explicit(self):
        from runtime_lease import WorkerLease

        script = ROOT / "scripts/runtime-db-maintenance.py"
        db = self.store.paths.db
        with self.store.transaction() as sql:
            sql.execute("CREATE TABLE filler(blob TEXT)")
            sql.executemany("INSERT INTO filler VALUES(?)", [("x" * 4000,)] * 500)
            sql.execute("DELETE FROM filler")
        run = lambda *args: subprocess.run(  # noqa: E731
            [sys.executable, str(script), *args, "--db", str(db)], capture_output=True, text=True
        )
        self.assertEqual(json.loads(run("stats").stdout)["autoVacuum"], "none")
        self.assertNotEqual(run("enable-incremental-vacuum").returncode, 0, "VACUUM without --yes")
        holder = WorkerLease(db.parent)
        self.assertTrue(holder.acquire())
        try:
            refused = run("enable-incremental-vacuum", "--yes")
            self.assertNotEqual(refused.returncode, 0)
            self.assertIn("lease", refused.stderr)
        finally:
            holder.release()
        done = run("enable-incremental-vacuum", "--yes")
        self.assertEqual(done.returncode, 0, done.stderr)
        after = json.loads(done.stdout)["after"]
        self.assertEqual((after["autoVacuum"], after["freePages"]), ("incremental", 0))
        self.assertTrue(self.store.compact().get("incrementalVacuum"))

    def test_gzip_replay_artifact_round_trip(self):
        artifacts = ArtifactStore(self.store)
        payload = json.dumps([{"text": "line\n" * 5000}])
        item = artifacts.put(task_id="t", project_dir="/p", kind="run-replay", title="r", content=payload, mime="application/json", compress=True)
        with self.store.connect() as db:
            path = Path(db.execute("SELECT file_path FROM artifacts WHERE id=?", (item["id"],)).fetchone()[0])
        self.assertTrue(path.name.endswith(".gz"))
        self.assertLess(path.stat().st_size, len(payload) // 10)
        self.assertEqual(gzip.decompress(path.read_bytes()).decode(), payload)
        got = artifacts.get(item["id"], limit=500000)
        self.assertEqual(got["content"], payload)
        self.assertEqual(got["size"], len(payload.encode()))
        self.assertEqual(artifacts.get(item["id"], query="line", limit=50)["content"][0]["line"], 1)


class MonitorAndMaintenanceTests(unittest.TestCase):
    def setUp(self):
        import server_runtime

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.runtime = server_runtime
        self.store = RuntimeStore(Path(self.tmp.name) / "state" / "runtime.sqlite3")
        self.store.initialize()
        self.original_store = server_runtime.STORE
        server_runtime.STORE = self.store
        self.addCleanup(setattr, server_runtime, "STORE", self.original_store)

    def features(self, busy=True):
        return SimpleNamespace(
            _status_busy=lambda value: bool(value) and busy,
            _permission_requests=lambda directory: [],
            _data=lambda value: value,
            _backend_request_json=lambda method, target, payload=None, timeout=10.0: [],
        )

    def test_busy_heartbeat_is_written_once(self):
        task = self.store.create_task(session_id="s", project_dir=self.tmp.name, text="t", files=[{"name": "a", "uri": ATTACHMENT}])
        self.store.claim_dispatch(task["id"])
        features = self.features()
        self.runtime._monitor_active(features, {"s": "busy"})
        first = self.store.get_task(task["id"])
        self.assertTrue(first["metadata"]["backendObservedBusy"])
        self.assertNotIn("progressCheckedAt", first["metadata"], "poll time stays in memory")
        with self.store.connect() as db:
            changes = db.total_changes
        for _ in range(5):
            self.runtime._monitor_active(features, {"s": "busy"})
        with self.store.connect() as db:
            self.assertEqual(db.total_changes, changes, "unchanged heartbeat rewrote the task row")
        self.assertEqual(self.store.get_task(task["id"])["updated_at"], first["updated_at"])

    def test_progress_conflicts_are_capped(self):
        task = self.store.create_task(session_id="s", project_dir=self.tmp.name, text="t")
        conflicts = [{"path": f"f{i}", "taskID": "other"} for i in range(120)]
        with patch.object(self.store, "ownership_replace", return_value=conflicts):
            self.runtime._monitor_progress(self.features(), self.store.get_task(task["id"], projection="summary"))
        metadata = self.store.get_task(task["id"])["metadata"]
        self.assertEqual(len(metadata["patchConflicts"]), self.runtime.PATCH_CONFLICTS_KEPT)
        self.assertEqual(metadata["patchConflictCount"], 120)

    def test_maintenance_runs_only_under_the_worker_lease(self):
        from runtime_lease import WorkerLease

        calls = []
        self.runtime.register_maintenance("perf-probe", lambda: calls.append(threading.current_thread().name), order=1)
        self.addCleanup(self.runtime.MAINTENANCE_HOOKS.pop, "perf-probe", None)
        holder = WorkerLease(self.store.paths.root)
        self.assertTrue(holder.acquire())  # another process owns the database
        stop = threading.Event()
        features = SimpleNamespace(WORKER_STOP=stop, _status_payload=lambda: {}, _apply_permission_policies=lambda: None,
                                   STATE_LOCK=threading.Lock(), _load_state_unlocked=lambda: {})
        with patch.dict(os.environ, {"OPENCODE_RUNTIME_MAINTENANCE_SECONDS": "1"}):
            self.runtime._MAINTENANCE_LAST_AT = 0.0
            worker = threading.Thread(target=self.runtime.worker, args=(features,), daemon=True)
            worker.start()
            time.sleep(1.2)
            self.assertEqual(calls, [], "maintenance ran without the worker lease")
            holder.release()
            deadline = time.time() + 10
            while not calls and time.time() < deadline:
                time.sleep(0.05)
            stop.set()
            worker.join(15)
        self.assertTrue(calls and set(calls) == {"custom-opencode-runtime-maintenance"}, calls)

    def test_v3_maintenance_is_durable_and_lease_scoped(self):
        import runtime_v3
        import runtime_v3_ext

        before = {thread.name for thread in threading.enumerate()}
        registered = {}
        runtime = SimpleNamespace(
            STORE=self.store,
            ARTIFACTS=ArtifactStore(self.store),
            SCHEDULER=SimpleNamespace(snapshot=lambda profiles: {}),
            register_maintenance=lambda name, hook, order=100: registered.__setitem__(name, hook),
        )
        with patch.object(runtime_v3, "_INSTANCE", None), patch.object(runtime_v3_ext, "_REGISTERED", False):
            runtime_v3_ext.install(runtime, runtime_v3, SimpleNamespace())
            v3 = runtime_v3._INSTANCE
        self.assertIn("runtime-v3", registered)
        self.assertNotIn("custom-opencode-v3-maintenance", {t.name for t in threading.enumerate()} - before)
        done = self.store.create_task(session_id="s-old", project_dir=self.tmp.name, text="old")
        self.store.transition(done["id"], "completed")
        sent, fetched = [], []
        v3.notifier = SimpleNamespace(send=sent.append)
        v3.indexer = SimpleNamespace(schedule_refresh=lambda project: True)

        class Features:
            fail = False

            @staticmethod
            def _data(value):
                return value

            def _backend_request_json(self, method, target, payload=None, timeout=15.0):
                fetched.append(target)
                if self.fail:
                    raise OSError("backend down")
                return [{"info": {"role": "assistant"}, "parts": [{"type": "text", "text": "ok"}]}]

        features = Features()
        tick = lambda: runtime_v3_ext.maintenance_tick(runtime, v3, features)  # noqa: E731
        first = tick()
        self.assertEqual(first["notified"], 0, "restart re-notified an already terminal task")
        self.assertEqual(sent, [])
        new = self.store.create_task(session_id="s-new", project_dir=self.tmp.name, text="new")
        self.store.transition(new["id"], "submitted")
        self.store.transition(new["id"], "failed", error="x")
        self.assertEqual(tick()["notified"], 1)
        self.assertEqual([item["taskID"] for item in sent], [new["id"]])
        runtime_v3_ext._REPLAY_BACKOFF.clear()  # simulate a process restart
        self.assertEqual(tick()["notified"], 0)
        self.assertEqual(len(sent), 1)
        replays = {
            row[0] for row in self.store.connect().__enter__().execute("SELECT task_id FROM artifacts WHERE kind='run-replay'")
        }
        self.assertEqual(replays, {done["id"], new["id"]}, "each finished task gets exactly one replay")
        calls = len(fetched)
        tick()
        self.assertEqual(len(fetched), calls, "replay existence must be checked in SQL")
        features.fail = True
        late = self.store.create_task(session_id="s-late", project_dir=self.tmp.name, text="late")
        self.store.transition(late["id"], "submitted")
        self.store.transition(late["id"], "completed")
        tick()
        tick()
        self.assertEqual(sum(1 for target in fetched if "s-late" in target), 1, "failed capture must back off")
        events = [e["kind"] for e in self.store.events(limit=2000)]
        self.assertEqual(events.count("notification.sent"), 2)


class IndexAndContextTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = RuntimeStore(Path(self.tmp.name) / "state" / "runtime.sqlite3")
        self.store.initialize()
        self.project = make_repo(Path(self.tmp.name))
        invalidate_git_snapshot()
        self.addCleanup(invalidate_git_snapshot)

    def test_stale_while_rebuild_single_flight(self):
        import runtime_v3

        indexer = runtime_v3.SemanticRepoIndexer(self.store)
        builds = []
        release = threading.Event()
        original = indexer._build

        def slow_build(*args, **kwargs):
            builds.append(time.monotonic())
            release.wait(10)
            return original(*args, **kwargs)

        with patch.object(indexer, "_build", side_effect=slow_build):
            first = indexer.refresh(str(self.project), allow_stale=True)
            self.assertTrue(first.get("building") and first["symbols"] == [])
            for _ in range(5):
                indexer.refresh(str(self.project), allow_stale=True)
            time.sleep(0.2)
            self.assertEqual(len(builds), 1, "concurrent stale reads started more than one build")
            release.set()
            deadline = time.time() + 20
            while indexer._scheduled and time.time() < deadline:
                time.sleep(0.05)
        ready = indexer.refresh(str(self.project), allow_stale=True)
        self.assertTrue(ready["cacheHit"] and any(s["qualified"] == "Engine.alpha" for s in ready["symbols"]))
        # A change within the minimum interval serves the stale index without a rebuild.
        (self.project / "core.py").write_text("class Engine:\n    def beta(self):\n        return 3\n", encoding="utf-8")
        invalidate_git_snapshot()
        with patch.dict(os.environ, {"OPENCODE_REPO_INDEX_MIN_INTERVAL_SECONDS": "3600"}):
            stale = indexer.refresh(str(self.project), allow_stale=True)
        self.assertTrue(stale["stale"] and stale["rebuilding"] is False)
        self.assertTrue(any(s["qualified"] == "Engine.alpha" for s in stale["symbols"]))
        # Explicit refresh stays synchronous and correct.
        fresh = indexer.refresh(str(self.project))
        self.assertFalse(fresh["cacheHit"])
        self.assertTrue(any(s["qualified"] == "Engine.beta" for s in fresh["symbols"]))

    def test_fingerprint_meta_and_lru(self):
        import runtime_v3

        indexer = runtime_v3.SemanticRepoIndexer(self.store)
        built = indexer.refresh(str(self.project))
        # Tool invalidation alone (unchanged tree) must not force a rebuild.
        invalidate_git_snapshot(str(self.project))
        snap = git_snapshot(str(self.project), fresh=True)
        self.assertEqual(indexer._fingerprint(snap), built["fingerprint"])
        # A cold process consults the small meta row and skips a stale blob.
        cold = runtime_v3.SemanticRepoIndexer(self.store)
        reads = []
        original = self.store.cache_get

        def counting(namespace, key):
            reads.append(namespace)
            return original(namespace, key)

        with patch.object(self.store, "cache_get", side_effect=counting):
            index, fresh = cold._lookup(cold._key(str(self.project.resolve())), "v4:other", None, want_stale=False)
        self.assertEqual((index, fresh), (None, False))
        self.assertEqual(reads, [cold.META_NAMESPACE], "stale blob was decoded")
        others = [make_repo(Path(self.tmp.name), f"p{i}") for i in range(2)]
        for project in [self.project, *others]:
            indexer.refresh(str(project))
        self.assertEqual(len(indexer._hot), 2)

    def test_semantic_diff_and_search_cached(self):
        import runtime_v3

        indexer = runtime_v3.SemanticRepoIndexer(self.store)
        baseline = git_snapshot(str(self.project), fresh=True)
        (self.project / "core.py").write_text("class Engine:\n    def alpha(self):\n        return 5\n", encoding="utf-8")
        snap = git_snapshot(str(self.project), fresh=True)
        calls = []
        original = runtime_v3._run

        def counting(cwd, argv, timeout=15.0):
            calls.append(argv[:2])
            return original(cwd, argv, timeout)

        with patch.object(runtime_v3, "_run", side_effect=counting):
            one = indexer.semantic_diff(str(self.project), baseline, snapshot=snap)
            two = indexer.semantic_diff(str(self.project), baseline, snapshot=snap)
        self.assertEqual(calls.count(["git", "diff"]), 1)
        self.assertEqual(one["changedSymbols"], two["changedSymbols"])
        self.assertTrue(any(s["qualified"] == "Engine.alpha" for s in two["changedSymbols"]))
        hits = indexer.search(str(self.project), "Engine alpha", snapshot=snap)
        with patch.object(runtime_v3, "_cosine", side_effect=AssertionError("search not cached")):
            self.assertEqual(indexer.search(str(self.project), "Engine alpha", snapshot=snap)["hits"], hits["hits"])

    def test_repo_diff_drivers_never_execute(self):
        # A repository can declare its own external diff driver / textconv;
        # server-side diffs must pass --no-ext-diff --no-textconv.
        import repo_services
        import runtime_v3
        import runtime_v3_ext

        marker = Path(self.tmp.name) / "driver-ran"
        evil = Path(self.tmp.name) / "evil.sh"
        evil.write_text(f"#!/bin/sh\ntouch {marker}\ncat \"$1\" 2>/dev/null\n", encoding="utf-8")
        evil.chmod(0o755)
        (self.project / ".gitattributes").write_text("*.py diff=evil\n*.txt diff=evil\n", encoding="utf-8")
        git(self.project, "config", "diff.evil.command", str(evil))
        git(self.project, "config", "diff.evil.textconv", str(evil))
        git(self.project, "add", ".gitattributes")
        git(self.project, "commit", "-qm", "attributes")
        baseline = git_snapshot(str(self.project), fresh=True)
        (self.project / "core.py").write_text("class Engine:\n    def alpha(self):\n        return 9\n", encoding="utf-8")
        snap = git_snapshot(str(self.project), fresh=True)
        diff = runtime_v3.SemanticRepoIndexer(self.store).semantic_diff(str(self.project), baseline, snapshot=snap)
        self.assertTrue(any(s["qualified"] == "Engine.alpha" for s in diff["changedSymbols"]))
        self.assertIn("core.py", repo_services.semantic_diff(str(self.project), baseline)["changedFiles"])
        self.assertFalse(marker.exists(), "repository diff driver executed during semantic diff")
        head = subprocess.run(["git", "-C", str(self.project), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        git(self.project, "checkout", "-q", "--", "core.py")
        worktree = Path(self.tmp.name) / "wt"
        git(self.project, "worktree", "add", "-q", "--detach", str(worktree), "HEAD")
        (worktree / "notes.txt").write_text("tracked\n", encoding="utf-8")
        git(worktree, "add", "notes.txt")
        git(worktree, "commit", "-qm", "notes")
        (worktree / "notes.txt").write_text("changed\n", encoding="utf-8")
        task = self.store.create_task(
            session_id="wt", project_dir=str(worktree), text="isolated",
            metadata={"ownershipRoot": str(self.project), "worktree": str(worktree)}, baseline={"head": head},
        )
        merged = runtime_v3_ext._worktree_merge(SimpleNamespace(STORE=self.store), task, False)
        self.assertEqual(merged["changed"], ["notes.txt"])
        self.assertEqual((self.project / "notes.txt").read_text(encoding="utf-8"), "changed\n")
        self.assertFalse(marker.exists(), "repository diff driver executed during worktree merge")

    def test_envelope_repo_block_is_byte_stable(self):
        import runtime_v3

        step = {"n": 0}

        class Indexer:
            def search(self, *args, **kwargs):
                step["n"] += 1
                bump = step["n"] / 100
                return {"hits": [
                    {"type": "symbol", "qualified": "Engine.alpha", "path": "b.py", "line": 9 + step["n"], "score": 0.9 + bump},
                    {"type": "file", "path": "a.py", "score": 0.5 - bump},
                ]}

            def semantic_diff(self, *args, **kwargs):
                return {"changedSymbols": [
                    {"qualified": "zeta", "path": "z.py", "line": step["n"]},
                    {"qualified": "Engine.alpha", "path": "b.py", "line": 40 + step["n"]},
                ]}

        manager = runtime_v3.DynamicContextManager(self.store, Indexer(), SimpleNamespace(search=lambda *a: None))
        runtime = SimpleNamespace(CONTEXT=SimpleNamespace(envelope=lambda **kwargs: {"text": ""}))
        features = SimpleNamespace(_session_directory=lambda sid: str(self.project), snapshot={"query": "Engine alpha"})
        with patch.object(manager, "maybe_compact", return_value={"budgetTokens": 48000}):
            texts = [manager.envelope(features, runtime, "s", "", rag_mode="off")["text"] for _ in range(3)]
        self.assertEqual(len(set(texts)), 1, texts)
        self.assertNotIn("score", texts[0])
        self.assertIn("- file: a.py\n- symbol: Engine.alpha · b.py", texts[0])
        self.assertIn("- Engine.alpha · b.py\n- zeta · z.py", texts[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
