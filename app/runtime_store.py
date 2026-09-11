#!/usr/bin/env python3
"""Durable SQLite store for server-side task/control-plane state."""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import json
import os
from pathlib import Path
import sqlite3
import threading
import time
from typing import Any, Iterable
from uuid import uuid4

SCHEMA_VERSION = 1
TASK_STATES = {
    "queued",
    "blocked",
    "paused",
    "submitted",
    "running",
    "waiting_permission",
    "verifying",
    "needs_attention",
    "completed",
    "failed",
    "cancelled",
    "recovering",
}
TERMINAL_STATES = {"completed", "failed", "cancelled"}
EXECUTION_STATES = frozenset(
    {"submitted", "running", "waiting_permission", "verifying", "recovering"}
)


def now_ms() -> int:
    return int(time.time() * 1000)


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def _loads(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return fallback


@dataclass(frozen=True)
class StorePaths:
    root: Path
    db: Path
    artifacts: Path
    worktrees: Path


class RuntimeStore:
    def __init__(self, db_path: str | Path | None = None):
        if db_path:
            db = Path(db_path).expanduser()
            root = db.parent
        else:
            configured = os.environ.get("CUSTOM_OPENCODE_RUNTIME_DB")
            if configured:
                db = Path(configured).expanduser()
                root = db.parent
            else:
                feature = os.environ.get("CUSTOM_OPENCODE_FEATURE_STATE")
                if feature:
                    root = Path(feature).expanduser().parent
                else:
                    xdg = Path(os.environ.get("XDG_STATE_HOME") or (Path.home() / ".local/state"))
                    root = xdg / "custom-opencode"
                db = root / "runtime-v2.sqlite3"
        self.paths = StorePaths(
            root=root, db=db, artifacts=root / "artifacts", worktrees=root / "worktrees"
        )
        self._init_lock = threading.Lock()
        self._initialized = False

    def initialize(self) -> None:
        if self._initialized:
            return
        with self._init_lock:
            if self._initialized:
                return
            self.paths.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.paths.artifacts.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.paths.worktrees.mkdir(parents=True, exist_ok=True, mode=0o700)
            with self.connect() as db:
                db.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
                    CREATE TABLE IF NOT EXISTS tasks (
                        id TEXT PRIMARY KEY,session_id TEXT NOT NULL,project_dir TEXT NOT NULL,
                        kind TEXT NOT NULL DEFAULT 'prompt',profile TEXT NOT NULL DEFAULT 'direct',
                        priority INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'queued',
                        text TEXT NOT NULL DEFAULT '',files_json TEXT NOT NULL DEFAULT '[]',metadata_json TEXT NOT NULL DEFAULT '{}',
                        created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,
                        last_progress_at INTEGER,dispatch_attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,
                        baseline_json TEXT NOT NULL DEFAULT '{}',route_json TEXT NOT NULL DEFAULT '{}',verification_json TEXT NOT NULL DEFAULT '{}'
                    );
                    CREATE INDEX IF NOT EXISTS idx_tasks_session_state ON tasks(session_id,state,priority DESC,created_at ASC);
                    CREATE INDEX IF NOT EXISTS idx_tasks_project_state ON tasks(project_dir,state,updated_at DESC);
                    CREATE TABLE IF NOT EXISTS task_dependencies (task_id TEXT NOT NULL,depends_on TEXT NOT NULL,PRIMARY KEY(task_id,depends_on));
                    CREATE INDEX IF NOT EXISTS idx_task_deps_target ON task_dependencies(depends_on);
                    CREATE TABLE IF NOT EXISTS events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT,session_id TEXT,project_dir TEXT,
                        kind TEXT NOT NULL,data_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id,id);
                    CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_dir,id DESC);
                    CREATE TABLE IF NOT EXISTS checkpoints (
                        id TEXT PRIMARY KEY,task_id TEXT NOT NULL,stage TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',
                        data_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON checkpoints(task_id,created_at DESC);
                    CREATE TABLE IF NOT EXISTS artifacts (
                        id TEXT PRIMARY KEY,task_id TEXT,project_dir TEXT,kind TEXT NOT NULL,title TEXT NOT NULL,
                        summary TEXT NOT NULL DEFAULT '',mime TEXT NOT NULL DEFAULT 'text/plain',inline_text TEXT,file_path TEXT,
                        size_bytes INTEGER NOT NULL DEFAULT 0,sha256 TEXT,created_at INTEGER NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id,created_at DESC);
                    CREATE TABLE IF NOT EXISTS cache (
                        namespace TEXT NOT NULL,cache_key TEXT NOT NULL,value_json TEXT NOT NULL,expires_at INTEGER,
                        updated_at INTEGER NOT NULL,PRIMARY KEY(namespace,cache_key)
                    );
                    CREATE TABLE IF NOT EXISTS usage (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT,model_ref TEXT,stage TEXT NOT NULL,
                        input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0,
                        cache_read_tokens INTEGER NOT NULL DEFAULT 0,cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                        cost REAL NOT NULL DEFAULT 0,latency_ms INTEGER NOT NULL DEFAULT 0,success INTEGER,created_at INTEGER NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS usage_keys (event_key TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
                    CREATE INDEX IF NOT EXISTS idx_usage_task ON usage(task_id,id);
                    CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(model_ref,id DESC);
                    CREATE TABLE IF NOT EXISTS project_memory (
                        project_dir TEXT NOT NULL,memory_key TEXT NOT NULL,value TEXT NOT NULL,category TEXT NOT NULL DEFAULT 'note',
                        updated_at INTEGER NOT NULL,PRIMARY KEY(project_dir,memory_key)
                    );
                    CREATE TABLE IF NOT EXISTS decisions (
                        id TEXT PRIMARY KEY,project_dir TEXT NOT NULL,title TEXT NOT NULL,decision TEXT NOT NULL,
                        rationale TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_dir,updated_at DESC);
                    CREATE TABLE IF NOT EXISTS mailbox (
                        id TEXT PRIMARY KEY,project_dir TEXT NOT NULL,from_task TEXT,to_task TEXT,message_type TEXT NOT NULL,
                        payload_json TEXT NOT NULL,consumed INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_mailbox_to ON mailbox(to_task,consumed,created_at);
                    CREATE TABLE IF NOT EXISTS patch_ownership (
                        project_dir TEXT NOT NULL,path TEXT NOT NULL,task_id TEXT NOT NULL,symbol TEXT NOT NULL DEFAULT '',
                        updated_at INTEGER NOT NULL,PRIMARY KEY(project_dir,path,task_id,symbol)
                    );
                    """
                )
                db.execute(
                    "INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)",
                    (str(SCHEMA_VERSION),),
                )
            try:
                os.chmod(self.paths.db, 0o600)
            except OSError:
                pass
            self._initialized = True

    @contextmanager
    def connect(self):
        self.paths.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        db = sqlite3.connect(str(self.paths.db), timeout=10.0, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            try:
                db.execute("PRAGMA journal_mode=WAL")
            except sqlite3.OperationalError:
                try:
                    db.execute("PRAGMA journal_mode=TRUNCATE")
                except sqlite3.OperationalError:
                    pass
            try:
                db.execute("PRAGMA synchronous=NORMAL")
            except sqlite3.OperationalError:
                pass
            db.execute("PRAGMA foreign_keys=OFF")
            yield db
        finally:
            db.close()

    @contextmanager
    def transaction(self):
        self.initialize()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                yield db
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    def _row_task(
        self, row: sqlite3.Row | None, dependencies: list[str] | None = None
    ) -> dict[str, Any] | None:
        if row is None:
            return None
        value = dict(row)
        value["files"] = _loads(value.pop("files_json", None), [])
        value["metadata"] = _loads(value.pop("metadata_json", None), {})
        value["baseline"] = _loads(value.pop("baseline_json", None), {})
        value["route"] = _loads(value.pop("route_json", None), {})
        value["verification"] = _loads(value.pop("verification_json", None), {})
        value["dependencies"] = (
            self.dependencies(value["id"]) if dependencies is None else dependencies
        )
        return value

    def create_task(
        self,
        *,
        session_id: str,
        project_dir: str,
        text: str = "",
        files: list[Any] | None = None,
        profile: str = "direct",
        priority: int = 0,
        dependencies: Iterable[str] = (),
        kind: str = "prompt",
        metadata: dict[str, Any] | None = None,
        baseline: dict[str, Any] | None = None,
        route: dict[str, Any] | None = None,
        task_id: str | None = None,
    ) -> dict[str, Any]:
        self.initialize()
        task_id = task_id or f"t_{uuid4().hex}"
        priority = max(-100, min(100, int(priority)))
        timestamp = now_ms()
        deps = [str(item) for item in dependencies if item and str(item) != task_id]
        with self.transaction() as db:
            db.execute(
                """INSERT INTO tasks(id,session_id,project_dir,kind,profile,priority,state,text,files_json,metadata_json,
                   created_at,updated_at,last_progress_at,baseline_json,route_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    task_id,
                    session_id,
                    project_dir,
                    kind,
                    profile,
                    priority,
                    "blocked" if deps else "queued",
                    text,
                    _json(files or []),
                    _json(metadata or {}),
                    timestamp,
                    timestamp,
                    timestamp,
                    _json(baseline or {}),
                    _json(route or {}),
                ),
            )
            for dependency in dict.fromkeys(deps):
                db.execute(
                    "INSERT OR IGNORE INTO task_dependencies(task_id,depends_on) VALUES(?,?)",
                    (task_id, dependency),
                )
            self._event_db(
                db,
                task_id,
                session_id,
                project_dir,
                "task.created",
                {"priority": priority, "profile": profile, "dependencies": deps, "kind": kind},
                timestamp,
            )
        return self.get_task(task_id) or {}

    def get_task(self, task_id: str) -> dict[str, Any] | None:
        self.initialize()
        with self.connect() as db:
            row = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        return self._row_task(row)

    def list_tasks(
        self,
        *,
        session_id: str | None = None,
        project_dir: str | None = None,
        states: Iterable[str] | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        self.initialize()
        clauses: list[str] = []
        args: list[Any] = []
        if session_id:
            clauses.append("session_id=?")
            args.append(session_id)
        if project_dir:
            clauses.append("project_dir=?")
            args.append(project_dir)
        state_list = [s for s in (states or []) if s in TASK_STATES]
        if state_list:
            clauses.append("state IN (%s)" % ",".join("?" for _ in state_list))
            args.extend(state_list)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        args.append(max(1, min(1000, int(limit))))
        with self.connect() as db:
            rows = db.execute(
                f"SELECT * FROM tasks{where} ORDER BY CASE WHEN state IN ('running','submitted','verifying','waiting_permission') THEN 0 ELSE 1 END,priority DESC,created_at ASC LIMIT ?",
                args,
            ).fetchall()
            ids = [str(row["id"]) for row in rows]
            dependencies: dict[str, list[str]] = {task_id: [] for task_id in ids}
            if ids:
                for dependency in db.execute(
                    "SELECT task_id,depends_on FROM task_dependencies WHERE task_id IN (%s) ORDER BY depends_on"
                    % ",".join("?" for _ in ids),
                    ids,
                ).fetchall():
                    dependencies[str(dependency["task_id"])].append(str(dependency["depends_on"]))
        return [self._row_task(row, dependencies[str(row["id"])]) or {} for row in rows]

    def dependencies(self, task_id: str) -> list[str]:
        self.initialize()
        with self.connect() as db:
            rows = db.execute(
                "SELECT depends_on FROM task_dependencies WHERE task_id=? ORDER BY depends_on",
                (task_id,),
            ).fetchall()
        return [str(row[0]) for row in rows]

    def dependency_state(self, task_id: str) -> tuple[bool, list[str]]:
        deps = self.dependencies(task_id)
        if not deps:
            return True, []
        with self.connect() as db:
            rows = db.execute(
                "SELECT id,state FROM tasks WHERE id IN (%s)" % ",".join("?" for _ in deps), deps
            ).fetchall()
        states = {str(row["id"]): str(row["state"]) for row in rows}
        waiting = [dep for dep in deps if states.get(dep) != "completed"]
        return not waiting, waiting

    def next_ready(self, *, session_id: str | None = None) -> dict[str, Any] | None:
        candidates = self.list_tasks(session_id=session_id, states=["queued", "blocked"], limit=500)
        for task in candidates:
            ready, waiting = self.dependency_state(task["id"])
            if ready:
                if task["state"] == "blocked":
                    self.transition(task["id"], "queued", event="task.unblocked", data={})
                    task = self.get_task(task["id"]) or task
                return task
            if task["state"] != "blocked":
                self.transition(
                    task["id"], "blocked", event="task.blocked", data={"waitingFor": waiting}
                )
        return None

    def claim_dispatch(self, task_id: str) -> dict[str, Any] | None:
        """Atomically move one dependency-ready queued task to submitted."""
        timestamp = now_ms()
        with self.transaction() as db:
            current = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if current is None or str(current["state"]) not in {"queued", "blocked"}:
                return None
            dependencies = db.execute(
                """SELECT dependency.depends_on,task.state
                   FROM task_dependencies dependency
                   LEFT JOIN tasks task ON task.id=dependency.depends_on
                   WHERE dependency.task_id=?""",
                (task_id,),
            ).fetchall()
            waiting = [
                str(row["depends_on"]) for row in dependencies if row["state"] != "completed"
            ]
            if waiting:
                if str(current["state"]) != "blocked":
                    db.execute(
                        "UPDATE tasks SET state='blocked',updated_at=?,last_progress_at=? WHERE id=?",
                        (timestamp, timestamp, task_id),
                    )
                    self._event_db(
                        db,
                        task_id,
                        str(current["session_id"]),
                        str(current["project_dir"]),
                        "task.blocked",
                        {"waitingFor": waiting},
                        timestamp,
                    )
                return None
            # A claim must serialize the session, not just this task row. Two
            # HTTP requests may both observe an idle UI before either is sent.
            # BEGIN IMMEDIATE protects this check across store instances too.
            occupied = db.execute(
                "SELECT 1 FROM tasks WHERE session_id=? AND id<>? AND state IN (%s) LIMIT 1"
                % ",".join("?" for _ in EXECUTION_STATES),
                (current["session_id"], task_id, *sorted(EXECUTION_STATES)),
            ).fetchone()
            if occupied:
                return None
            claimed = db.execute(
                """UPDATE tasks
                   SET state='submitted',updated_at=?,last_progress_at=?,
                       started_at=COALESCE(started_at,?),dispatch_attempts=dispatch_attempts+1
                   WHERE id=? AND state IN ('queued','blocked')""",
                (timestamp, timestamp, timestamp, task_id),
            )
            if claimed.rowcount != 1:
                return None
            self._event_db(
                db,
                task_id,
                str(current["session_id"]),
                str(current["project_dir"]),
                "task.claimed",
                {},
                timestamp,
            )
        return self.get_task(task_id)

    def transition(
        self,
        task_id: str,
        state: str,
        *,
        event: str | None = None,
        data: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        if state not in TASK_STATES:
            raise ValueError(f"invalid task state: {state}")
        timestamp = now_ms()
        with self.transaction() as db:
            current = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if current is None:
                raise KeyError(task_id)
            updates = ["state=?", "updated_at=?", "last_progress_at=?"]
            args: list[Any] = [state, timestamp, timestamp]
            if state in {"submitted", "running"} and current["started_at"] is None:
                updates.append("started_at=?")
                args.append(timestamp)
            if state in TERMINAL_STATES or state == "needs_attention":
                updates.append("finished_at=?")
                args.append(timestamp)
            if error is not None:
                updates.append("last_error=?")
                args.append(str(error)[:4000])
            args.append(task_id)
            db.execute(f"UPDATE tasks SET {','.join(updates)} WHERE id=?", args)
            if state in TERMINAL_STATES:
                db.execute("DELETE FROM patch_ownership WHERE task_id=?", (task_id,))
            self._event_db(
                db,
                task_id,
                str(current["session_id"]),
                str(current["project_dir"]),
                event or f"task.{state}",
                data or {},
                timestamp,
            )
        return self.get_task(task_id) or {}

    def update_task(
        self,
        task_id: str,
        *,
        priority: int | None = None,
        dependencies: Iterable[str] | None = None,
        metadata_patch: dict[str, Any] | None = None,
        route: dict[str, Any] | None = None,
        verification: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        timestamp = now_ms()
        with self.transaction() as db:
            row = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                raise KeyError(task_id)
            updates = ["updated_at=?"]
            args: list[Any] = [timestamp]
            changes: dict[str, Any] = {}
            if priority is not None:
                value = max(-100, min(100, int(priority)))
                updates.append("priority=?")
                args.append(value)
                if value != row["priority"]:
                    changes["priority"] = value
            if metadata_patch is not None:
                current = _loads(row["metadata_json"], {})
                current = current if isinstance(current, dict) else {}
                current.update(metadata_patch)
                updates.append("metadata_json=?")
                args.append(_json(current))
            if route is not None:
                updates.append("route_json=?")
                args.append(_json(route))
                if route != _loads(row["route_json"], {}):
                    changes["route"] = route
            if verification is not None:
                updates.append("verification_json=?")
                args.append(_json(verification))
                if verification != _loads(row["verification_json"], {}):
                    changes["verification"] = verification
            args.append(task_id)
            db.execute(f"UPDATE tasks SET {','.join(updates)} WHERE id=?", args)
            if dependencies is not None:
                deps = list(
                    dict.fromkeys(
                        str(item) for item in dependencies if item and str(item) != task_id
                    )
                )
                before = {
                    item[0]
                    for item in db.execute(
                        "SELECT depends_on FROM task_dependencies WHERE task_id=?", (task_id,)
                    )
                }
                if set(deps) != before:
                    changes["dependencies"] = deps
                db.execute("DELETE FROM task_dependencies WHERE task_id=?", (task_id,))
                for dep in dict.fromkeys(deps):
                    db.execute(
                        "INSERT OR IGNORE INTO task_dependencies(task_id,depends_on) VALUES(?,?)",
                        (task_id, dep),
                    )
                if str(row["state"]) in {"queued", "blocked", "paused"}:
                    state = "queued" if not deps else "blocked"
                    db.execute("UPDATE tasks SET state=? WHERE id=?", (state, task_id))
                    if state != row["state"]:
                        changes["state"] = state
            # Progress/heartbeat metadata is persisted, not a user-facing edit.
            if changes:
                self._event_db(
                    db,
                    task_id,
                    str(row["session_id"]),
                    str(row["project_dir"]),
                    "task.updated",
                    changes,
                    timestamp,
                )
        return self.get_task(task_id) or {}

    def reorder(self, session_id: str, ids: list[str]) -> None:
        for index, task_id in enumerate(ids[:200]):
            task = self.get_task(task_id)
            if (
                task
                and task["session_id"] == session_id
                and task["state"] in {"queued", "blocked", "paused"}
            ):
                self.update_task(task_id, priority=max(-100, 50 - index))

    def event(
        self,
        *,
        kind: str,
        task_id: str | None = None,
        session_id: str | None = None,
        project_dir: str | None = None,
        data: dict[str, Any] | None = None,
    ) -> int:
        self.initialize()
        timestamp = now_ms()
        with self.transaction() as db:
            return self._event_db(db, task_id, session_id, project_dir, kind, data or {}, timestamp)

    def _event_db(
        self,
        db: sqlite3.Connection,
        task_id: str | None,
        session_id: str | None,
        project_dir: str | None,
        kind: str,
        data: dict[str, Any],
        timestamp: int,
    ) -> int:
        cur = db.execute(
            "INSERT INTO events(task_id,session_id,project_dir,kind,data_json,created_at) VALUES(?,?,?,?,?,?)",
            (task_id, session_id, project_dir, kind, _json(data), timestamp),
        )
        return int(cur.lastrowid)

    def events(
        self,
        *,
        task_id: str | None = None,
        session_id: str | None = None,
        project_dir: str | None = None,
        after: int = 0,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        self.initialize()
        clauses = ["id>?"]
        args: list[Any] = [int(after)]
        if task_id:
            clauses.append("task_id=?")
            args.append(task_id)
        if session_id is not None:
            clauses.append("session_id=?")
            args.append(session_id)
        if project_dir:
            clauses.append("project_dir=?")
            args.append(project_dir)
        args.append(max(1, min(2000, int(limit))))
        with self.connect() as db:
            rows = db.execute(
                f"SELECT * FROM events WHERE {' AND '.join(clauses)} ORDER BY id ASC LIMIT ?", args
            ).fetchall()
        return [{**dict(row), "data": _loads(row["data_json"], {})} for row in rows]

    def checkpoint(
        self, task_id: str, stage: str, *, summary: str = "", data: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        task = self.get_task(task_id)
        if not task:
            raise KeyError(task_id)
        cid = f"cp_{uuid4().hex}"
        timestamp = now_ms()
        with self.transaction() as db:
            db.execute(
                "INSERT INTO checkpoints(id,task_id,stage,summary,data_json,created_at) VALUES(?,?,?,?,?,?)",
                (cid, task_id, stage, str(summary)[:4000], _json(data or {}), timestamp),
            )
            self._event_db(
                db,
                task_id,
                task["session_id"],
                task["project_dir"],
                "checkpoint.saved",
                {"checkpointID": cid, "stage": stage, "summary": str(summary)[:500]},
                timestamp,
            )
        return {
            "id": cid,
            "taskID": task_id,
            "stage": stage,
            "summary": str(summary)[:4000],
            "data": data or {},
            "createdAt": timestamp,
        }

    def checkpoints(self, task_id: str, limit: int = 100) -> list[dict[str, Any]]:
        self.initialize()
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM checkpoints WHERE task_id=? ORDER BY created_at DESC LIMIT ?",
                (task_id, max(1, min(500, int(limit)))),
            ).fetchall()
        return [
            {
                "id": r["id"],
                "taskID": r["task_id"],
                "stage": r["stage"],
                "summary": r["summary"],
                "data": _loads(r["data_json"], {}),
                "createdAt": r["created_at"],
            }
            for r in rows
        ]

    def cache_set(
        self, namespace: str, key: str, value: Any, ttl_seconds: float | None = None
    ) -> None:
        self.initialize()
        timestamp = now_ms()
        expires = timestamp + int(ttl_seconds * 1000) if ttl_seconds else None
        with self.transaction() as db:
            db.execute(
                "INSERT OR REPLACE INTO cache(namespace,cache_key,value_json,expires_at,updated_at) VALUES(?,?,?,?,?)",
                (namespace, key, _json(value), expires, timestamp),
            )

    def cache_get(self, namespace: str, key: str) -> Any | None:
        self.initialize()
        timestamp = now_ms()
        with self.connect() as db:
            row = db.execute(
                "SELECT value_json,expires_at FROM cache WHERE namespace=? AND cache_key=?",
                (namespace, key),
            ).fetchone()
        if not row:
            return None
        if row["expires_at"] is not None and int(row["expires_at"]) < timestamp:
            with self.transaction() as db:
                db.execute("DELETE FROM cache WHERE namespace=? AND cache_key=?", (namespace, key))
            return None
        return _loads(row["value_json"], None)

    def prune(self, retention_days: int | None = None) -> dict[str, int]:
        """Drop expired cache entries and old terminal task data."""
        self.initialize()
        timestamp = now_ms()
        days = max(
            1,
            int(
                retention_days
                if retention_days is not None
                else os.environ.get("OPENCODE_RUNTIME_RETENTION_DAYS", "30")
            ),
        )
        cutoff = timestamp - days * 86_400_000
        with self.transaction() as db:
            db.execute(
                "CREATE TEMP TABLE prune_tasks AS SELECT id FROM tasks WHERE state IN ('completed','failed','cancelled') AND COALESCE(finished_at,updated_at)<? AND id NOT IN (SELECT depends_on FROM task_dependencies)",
                (cutoff,),
            )
            old_tasks = "SELECT id FROM prune_tasks"
            files = [
                str(row[0])
                for row in db.execute(
                    f"SELECT file_path FROM artifacts WHERE file_path IS NOT NULL AND (task_id IN ({old_tasks}) OR (task_id IS NULL AND created_at<?))",
                    (cutoff,),
                ).fetchall()
            ]
            expired = db.execute(
                "DELETE FROM cache WHERE expires_at IS NOT NULL AND expires_at<?", (timestamp,)
            ).rowcount
            artifacts = db.execute(
                f"DELETE FROM artifacts WHERE task_id IN ({old_tasks}) OR (task_id IS NULL AND created_at<?)",
                (cutoff,),
            ).rowcount
            db.execute(f"DELETE FROM checkpoints WHERE task_id IN ({old_tasks})")
            db.execute(
                f"DELETE FROM usage WHERE task_id IN ({old_tasks}) OR (task_id IS NULL AND created_at<?)",
                (cutoff,),
            )
            db.execute(
                f"DELETE FROM events WHERE task_id IN ({old_tasks}) OR (task_id IS NULL AND created_at<?)",
                (cutoff,),
            )
            db.execute(
                f"DELETE FROM mailbox WHERE from_task IN ({old_tasks}) OR to_task IN ({old_tasks}) OR (consumed=1 AND created_at<?)",
                (cutoff,),
            )
            db.execute(f"DELETE FROM patch_ownership WHERE task_id IN ({old_tasks})")
            db.execute(
                f"DELETE FROM task_dependencies WHERE task_id IN ({old_tasks}) OR depends_on IN ({old_tasks})"
            )
            tasks = db.execute(f"DELETE FROM tasks WHERE id IN ({old_tasks})").rowcount
        artifact_root = self.paths.artifacts.resolve(strict=False)
        removed = 0
        for raw in files:
            try:
                path = Path(raw).resolve(strict=False)
                path.relative_to(artifact_root)
                path.unlink(missing_ok=True)
                removed += 1
            except (OSError, RuntimeError, ValueError):
                pass
        return {"expiredCache": expired, "tasks": tasks, "artifacts": artifacts, "files": removed}

    def consume_rate(self, scope: str, limit: int, window_ms: int = 60000) -> None:
        self.initialize()
        with self.transaction() as db:
            current = now_ms()
            row = db.execute(
                "SELECT value_json FROM cache WHERE namespace='mcp-rate-window' AND cache_key=?",
                (scope,),
            ).fetchone()
            timestamps = _loads(row["value_json"], []) if row else []
            timestamps = [int(t) for t in timestamps if current - window_ms < int(t)]
            if len(timestamps) >= max(1, limit):
                retry_after = max(1, (timestamps[0] + window_ms - current + 999) // 1000)
                error = RuntimeError(
                    f"MCP rate limit exceeded for {scope}; retry_after={retry_after}s"
                )
                error.retry_after = retry_after
                raise error
            timestamps.append(current)
            db.execute(
                "INSERT OR REPLACE INTO cache(namespace,cache_key,value_json,expires_at,updated_at) VALUES('mcp-rate-window',?,?,?,?)",
                (scope, _json(timestamps), current + window_ms, current),
            )

    def add_usage(
        self,
        *,
        task_id: str | None,
        model_ref: str | None,
        stage: str,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cache_read_tokens: int = 0,
        cache_write_tokens: int = 0,
        cost: float = 0.0,
        latency_ms: int = 0,
        success: bool | None = None,
        event_key: str | None = None,
    ) -> None:
        self.initialize()
        with self.transaction() as db:
            if event_key:
                inserted = db.execute(
                    "INSERT OR IGNORE INTO usage_keys(event_key,created_at) VALUES(?,?)",
                    (event_key, now_ms()),
                ).rowcount
                if not inserted:
                    return
            db.execute(
                "INSERT INTO usage(task_id,model_ref,stage,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost,latency_ms,success,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    task_id,
                    model_ref,
                    stage,
                    int(input_tokens),
                    int(output_tokens),
                    int(cache_read_tokens),
                    int(cache_write_tokens),
                    float(cost),
                    int(latency_ms),
                    None if success is None else int(bool(success)),
                    now_ms(),
                ),
            )

    def usage_summary(self, task_id: str | None = None) -> dict[str, Any]:
        self.initialize()
        where = " WHERE task_id=?" if task_id else ""
        args = (task_id,) if task_id else ()
        with self.connect() as db:
            rows = db.execute(
                f"SELECT stage,SUM(input_tokens) i,SUM(output_tokens) o,SUM(cache_read_tokens) cr,SUM(cache_write_tokens) cw,SUM(cost) cost,SUM(latency_ms) latency,COUNT(*) n FROM usage{where} GROUP BY stage",
                args,
            ).fetchall()
        stages = {
            str(r["stage"]): {
                "inputTokens": int(r["i"] or 0),
                "outputTokens": int(r["o"] or 0),
                "cacheReadTokens": int(r["cr"] or 0),
                "cacheWriteTokens": int(r["cw"] or 0),
                "cost": float(r["cost"] or 0),
                "latencyMs": int(r["latency"] or 0),
                "samples": int(r["n"] or 0),
            }
            for r in rows
        }
        return {
            "stages": stages,
            "total": {
                "inputTokens": sum(v["inputTokens"] for v in stages.values()),
                "outputTokens": sum(v["outputTokens"] for v in stages.values()),
                "cost": sum(v["cost"] for v in stages.values()),
                "latencyMs": sum(v["latencyMs"] for v in stages.values()),
            },
        }

    def model_stats(self, model_ref: str, limit: int = 200) -> dict[str, Any]:
        self.initialize()
        with self.connect() as db:
            rows = db.execute(
                "SELECT success,latency_ms,cost FROM usage WHERE model_ref=? ORDER BY id DESC LIMIT ?",
                (model_ref, max(1, min(1000, int(limit)))),
            ).fetchall()
        if not rows:
            return {"samples": 0, "successRate": None, "avgLatencyMs": None, "avgCost": None}
        known = [int(r["success"]) for r in rows if r["success"] is not None]
        return {
            "samples": len(rows),
            "successRate": sum(known) / len(known) if known else None,
            "avgLatencyMs": sum(int(r["latency_ms"] or 0) for r in rows) / len(rows),
            "avgCost": sum(float(r["cost"] or 0) for r in rows) / len(rows),
        }

    def memory_set(self, project_dir: str, key: str, value: str, category: str = "note") -> None:
        self.initialize()
        with self.transaction() as db:
            db.execute(
                "INSERT OR REPLACE INTO project_memory(project_dir,memory_key,value,category,updated_at) VALUES(?,?,?,?,?)",
                (project_dir, key[:240], value[:20000], category[:80], now_ms()),
            )

    def memory_list(self, project_dir: str, limit: int = 100) -> list[dict[str, Any]]:
        self.initialize()
        with self.connect() as db:
            rows = db.execute(
                "SELECT memory_key,value,category,updated_at FROM project_memory WHERE project_dir=? ORDER BY updated_at DESC LIMIT ?",
                (project_dir, max(1, min(500, int(limit)))),
            ).fetchall()
        return [
            {
                "key": r["memory_key"],
                "value": r["value"],
                "category": r["category"],
                "updatedAt": r["updated_at"],
            }
            for r in rows
        ]

    def decision_add(
        self, project_dir: str, title: str, decision: str, rationale: str = ""
    ) -> dict[str, Any]:
        self.initialize()
        item = f"d_{uuid4().hex}"
        timestamp = now_ms()
        with self.transaction() as db:
            db.execute(
                "INSERT INTO decisions(id,project_dir,title,decision,rationale,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                (
                    item,
                    project_dir,
                    title[:500],
                    decision[:12000],
                    rationale[:12000],
                    "active",
                    timestamp,
                    timestamp,
                ),
            )
        return {
            "id": item,
            "projectDir": project_dir,
            "title": title[:500],
            "decision": decision[:12000],
            "rationale": rationale[:12000],
            "status": "active",
            "createdAt": timestamp,
        }

    def decision_list(self, project_dir: str, limit: int = 100) -> list[dict[str, Any]]:
        self.initialize()
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM decisions WHERE project_dir=? AND status='active' ORDER BY updated_at DESC LIMIT ?",
                (project_dir, max(1, min(500, int(limit)))),
            ).fetchall()
        return [
            {
                "id": r["id"],
                "title": r["title"],
                "decision": r["decision"],
                "rationale": r["rationale"],
                "status": r["status"],
                "createdAt": r["created_at"],
                "updatedAt": r["updated_at"],
            }
            for r in rows
        ]

    def mailbox_send(
        self,
        *,
        project_dir: str,
        message_type: str,
        payload: dict[str, Any],
        from_task: str | None = None,
        to_task: str | None = None,
    ) -> dict[str, Any]:
        self.initialize()
        item = f"m_{uuid4().hex}"
        timestamp = now_ms()
        with self.transaction() as db:
            db.execute(
                "INSERT INTO mailbox(id,project_dir,from_task,to_task,message_type,payload_json,consumed,created_at) VALUES(?,?,?,?,?,?,0,?)",
                (
                    item,
                    project_dir,
                    from_task,
                    to_task,
                    message_type[:80],
                    _json(payload),
                    timestamp,
                ),
            )
        return {
            "id": item,
            "projectDir": project_dir,
            "fromTask": from_task,
            "toTask": to_task,
            "type": message_type[:80],
            "payload": payload,
            "createdAt": timestamp,
        }

    def mailbox_receive(
        self, task_id: str, *, consume: bool = False, limit: int = 100
    ) -> list[dict[str, Any]]:
        self.initialize()
        with self.transaction() as db:
            rows = db.execute(
                "SELECT * FROM mailbox WHERE to_task=? AND consumed=0 ORDER BY created_at ASC LIMIT ?",
                (task_id, max(1, min(500, int(limit)))),
            ).fetchall()
            ids = [str(r["id"]) for r in rows]
            if consume and ids:
                db.execute(
                    "UPDATE mailbox SET consumed=1 WHERE id IN (%s)" % ",".join("?" for _ in ids),
                    ids,
                )
        return [
            {
                "id": r["id"],
                "fromTask": r["from_task"],
                "toTask": r["to_task"],
                "type": r["message_type"],
                "payload": _loads(r["payload_json"], {}),
                "createdAt": r["created_at"],
            }
            for r in rows
        ]

    def ownership_replace(
        self, project_dir: str, task_id: str, paths: Iterable[str]
    ) -> list[dict[str, Any]]:
        self.initialize()
        timestamp = now_ms()
        root = Path(project_dir).expanduser().resolve(strict=False)
        normalized = []
        for raw in paths:
            if not raw:
                continue
            target = Path(str(raw)).expanduser()
            target = target if target.is_absolute() else root / target
            try:
                relative = target.resolve(strict=False).relative_to(root).as_posix()
            except (OSError, RuntimeError, ValueError) as exc:
                raise ValueError(f"ownership path outside project: {raw}") from exc
            if relative and relative != ".":
                normalized.append(relative[:2000])
        normalized = sorted(set(normalized))
        with self.transaction() as db:
            project = str(root)
            if not normalized:
                db.execute(
                    "DELETE FROM patch_ownership WHERE project_dir=? AND task_id=?",
                    (project, task_id),
                )
                return []
            rows = db.execute(
                """SELECT ownership.path,ownership.task_id
                   FROM patch_ownership ownership
                   JOIN tasks task ON task.id=ownership.task_id
                   WHERE ownership.project_dir=? AND ownership.task_id<>?
                     AND task.state NOT IN ('completed','failed','cancelled')
                     AND ownership.path IN (%s)"""
                % ",".join("?" for _ in normalized),
                [project, task_id, *normalized],
            ).fetchall()
            if rows:
                # Reject the whole acquisition. Inserting before checking left
                # denied agents holding locks and deadlocked the rightful owner.
                return [{"path": r["path"], "taskID": r["task_id"]} for r in rows]
            for path in normalized:
                db.execute(
                    "INSERT OR REPLACE INTO patch_ownership(project_dir,path,task_id,symbol,updated_at) VALUES(?,?,?,?,?)",
                    (project, path, task_id, "", timestamp),
                )
        return []

    def recover_inflight(self) -> int:
        self.initialize()
        timestamp = now_ms()
        with self.transaction() as db:
            rows = db.execute(
                "SELECT id,session_id,project_dir,state FROM tasks WHERE state IN ('submitted','running','verifying','waiting_permission')"
            ).fetchall()
            for r in rows:
                db.execute(
                    "UPDATE tasks SET state='recovering',updated_at=?,last_progress_at=? WHERE id=?",
                    (timestamp, timestamp, r["id"]),
                )
                self._event_db(
                    db,
                    r["id"],
                    r["session_id"],
                    r["project_dir"],
                    "task.recovering",
                    {"previousState": r["state"]},
                    timestamp,
                )
        return len(rows)
