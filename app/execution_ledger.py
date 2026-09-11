"""Durable, atomic budgets shared by a native turn and all of its subagents.

Reservations are not provider charges. Missing/ambiguous usage stays unknown,
with the reservation retained, instead of inventing zero spend or retrying.
"""

from __future__ import annotations
import hashlib
import json
import os
from typing import Any
from runtime_store import RuntimeStore, now_ms

DEFAULT_LIMITS = {
    "calls": 128,
    "outputTokens": 1048576,
    "toolAttempts": 1024,
    "seconds": 7200,
    "finishTokens": 4096,
}


class BudgetExceeded(RuntimeError):
    pass


class ExecutionLedger:
    def __init__(self, store: RuntimeStore):
        self.store = store
        with store.transaction() as db:
            schema = """
                CREATE TABLE IF NOT EXISTS execution_roots(
                    id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                    started_at INTEGER NOT NULL, limits_json TEXT NOT NULL,
                    calls INTEGER NOT NULL DEFAULT 0, tools INTEGER NOT NULL DEFAULT 0,
                    output_reserved INTEGER NOT NULL DEFAULT 0,
                    finish_used INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS execution_bindings(
                    session_id TEXT PRIMARY KEY, root_id TEXT NOT NULL,
                    turn_id TEXT NOT NULL, parent_id TEXT, model_ref TEXT,
                    directory TEXT NOT NULL, task_id TEXT);
                CREATE TABLE IF NOT EXISTS execution_requests(
                    id TEXT PRIMARY KEY, root_id TEXT NOT NULL, session_id TEXT NOT NULL,
                    model_ref TEXT, started_at INTEGER NOT NULL, finished_at INTEGER,
                    state TEXT NOT NULL, status INTEGER, reserved INTEGER NOT NULL,
                    usage_json TEXT, error TEXT);
                CREATE INDEX IF NOT EXISTS execution_requests_root ON execution_requests(root_id);
                CREATE TABLE IF NOT EXISTS execution_review_claims(
                    root_id TEXT NOT NULL, change_id TEXT NOT NULL, owner TEXT NOT NULL,
                    task_id TEXT, PRIMARY KEY(root_id,change_id));
            """
            for statement in schema.split(";"):
                if statement.strip():
                    db.execute(statement)

    @staticmethod
    def limits() -> dict[str, int]:
        raw = json.loads(os.environ.get("OPENCODE_ROOT_BUDGET_JSON", "{}"))
        if not isinstance(raw, dict) or set(raw) - set(DEFAULT_LIMITS):
            raise ValueError("Unknown root budget fields")
        result = {key: int(raw.get(key, value)) for key, value in DEFAULT_LIMITS.items()}
        if any(value < 1 for value in result.values()):
            raise ValueError("Root budget limits must be positive")
        if result["finishTokens"] >= result["outputTokens"]:
            raise ValueError("Root output budget must exceed its finish reserve")
        return result

    def bind(
        self,
        *,
        session_id: str,
        turn_id: str,
        parent_id: str | None,
        directory: str,
        model_ref: str | None,
        task: dict | None = None,
    ) -> dict:
        if not session_id or len(session_id) > 256 or len(turn_id) > 256:
            raise ValueError("Invalid native session/turn ID")
        if parent_id == session_id:
            raise ValueError("Session cannot be its own parent")
        with self.store.transaction() as db:
            old = db.execute(
                "SELECT * FROM execution_bindings WHERE session_id=?", (session_id,)
            ).fetchone()
            if parent_id:
                parent = db.execute(
                    "SELECT * FROM execution_bindings WHERE session_id=?", (parent_id,)
                ).fetchone()
                if not parent:
                    raise PermissionError(
                        "Native child has no bound parent; refusing to borrow a task by directory"
                    )
                root_id = (
                    old["root_id"] if old and old["parent_id"] == parent_id else parent["root_id"]
                )
            elif task:
                metadata = task.get("metadata") or {}
                root_id = str(metadata.get("rootTaskID") or task["id"])
            elif old and (not turn_id or not old["turn_id"] or old["turn_id"] == turn_id):
                root_id = old["root_id"]
            else:
                root_id = (
                    "native_"
                    + hashlib.sha256((session_id + ":" + turn_id).encode()).hexdigest()[:32]
                )
            limits = self.limits()
            db.execute(
                "INSERT OR IGNORE INTO execution_roots(id,session_id,started_at,limits_json) VALUES(?,?,?,?)",
                (root_id, session_id, now_ms(), json.dumps(limits)),
            )
            effective_turn = turn_id or (old["turn_id"] if old else "")
            db.execute(
                "INSERT INTO execution_bindings VALUES(?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET root_id=excluded.root_id,turn_id=excluded.turn_id,parent_id=excluded.parent_id,model_ref=excluded.model_ref,directory=excluded.directory,task_id=excluded.task_id",
                (
                    session_id,
                    root_id,
                    effective_turn,
                    parent_id,
                    model_ref,
                    directory,
                    (task or {}).get("id"),
                ),
            )
        return self.snapshot(session_id)

    def binding(self, session_id: str) -> dict | None:
        with self.store.connect() as db:
            row = db.execute(
                "SELECT * FROM execution_bindings WHERE session_id=?", (session_id,)
            ).fetchone()
        return dict(row) if row else None

    def snapshot(self, session_id: str) -> dict:
        binding = self.binding(session_id)
        if not binding:
            raise PermissionError("Native session is not bound to an execution budget")
        with self.store.connect() as db:
            row = db.execute(
                "SELECT * FROM execution_roots WHERE id=?", (binding["root_id"],)
            ).fetchone()
        value = dict(row)
        value["limits"] = json.loads(value.pop("limits_json"))
        value["rootID"] = value.pop("id")
        value["usageAccounting"] = "output reservations; unknown provider usage is not zero"
        return value

    def reserve(
        self, session_id: str, request_id: str, *, output_limit: int, finish: bool = False
    ) -> dict:
        if not request_id or len(request_id) > 256:
            raise ValueError("Invalid request ID")
        binding = self.binding(session_id)
        if not binding:
            raise PermissionError("Model request has no bound root budget")
        failure = None
        with self.store.transaction() as db:
            previous = db.execute(
                "SELECT * FROM execution_requests WHERE id=?", (request_id,)
            ).fetchone()
            if previous:
                if previous["session_id"] != session_id:
                    raise PermissionError("Request owner mismatch")
                return {
                    "requestID": request_id,
                    "rootID": previous["root_id"],
                    "maxOutputTokens": previous["reserved"],
                    "reused": True,
                }
            root = db.execute(
                "SELECT * FROM execution_roots WHERE id=?", (binding["root_id"],)
            ).fetchone()
            limits = json.loads(root["limits_json"])
            elapsed = now_ms() - root["started_at"]
            remaining = limits["outputTokens"] - root["output_reserved"]
            if finish:
                if root["finish_used"]:
                    failure = "completion reserve already used"
                allowed = min(max(1, output_limit), limits["finishTokens"], remaining)
            else:
                allowed = min(max(1, output_limit), remaining - limits["finishTokens"])
                if root["calls"] >= limits["calls"]:
                    failure = "model call budget exhausted"
                elif elapsed > limits["seconds"] * 1000:
                    failure = "root task time budget exhausted"
            if allowed < 1:
                failure = "root output/reasoning budget exhausted"
            if not failure:
                db.execute(
                    "UPDATE execution_roots SET calls=calls+1,output_reserved=output_reserved+?,finish_used=MAX(finish_used,?) WHERE id=?",
                    (allowed, int(finish), binding["root_id"]),
                )
                db.execute(
                    "INSERT INTO execution_requests(id,root_id,session_id,model_ref,started_at,state,reserved) VALUES(?,?,?,?,?,'reserved',?)",
                    (
                        request_id,
                        binding["root_id"],
                        session_id,
                        binding["model_ref"],
                        now_ms(),
                        allowed,
                    ),
                )
        if failure:
            self._checkpoint(binding, failure)
            raise BudgetExceeded(failure + "; durable budget checkpoint saved")
        return {
            "requestID": request_id,
            "rootID": binding["root_id"],
            "maxOutputTokens": allowed,
            "finishOnly": finish,
        }

    def _checkpoint(self, binding: dict, reason: str) -> None:
        data = {
            "rootID": binding["root_id"],
            "reason": reason,
            "budget": self.snapshot(binding["session_id"]),
        }
        self.store.event(
            kind="execution.budget_exhausted",
            session_id=binding["session_id"],
            task_id=binding.get("task_id"),
            data=data,
        )
        if binding.get("task_id"):
            self.store.checkpoint(binding["task_id"], "budget-exhausted", summary=reason, data=data)
        self.store.cache_set(
            "native-budget-checkpoint", binding["root_id"], data, ttl_seconds=7 * 86400
        )

    def tool(self, session_id: str) -> None:
        binding = self.binding(session_id)
        if not binding:
            raise PermissionError("Native tool has no bound root budget")
        failure = None
        with self.store.transaction() as db:
            row = db.execute(
                "SELECT * FROM execution_roots WHERE id=?", (binding["root_id"],)
            ).fetchone()
            limits = json.loads(row["limits_json"])
            if row["finish_used"]:
                failure = "completion-only request cannot execute tools"
            elif row["tools"] >= limits["toolAttempts"]:
                failure = "root tool-attempt budget exhausted"
            elif now_ms() - row["started_at"] > limits["seconds"] * 1000:
                failure = "root task time budget exhausted"
            else:
                db.execute(
                    "UPDATE execution_roots SET tools=tools+1 WHERE id=?", (binding["root_id"],)
                )
        if failure:
            self._checkpoint(binding, failure)
            raise BudgetExceeded(failure)

    def finish(
        self,
        session_id: str,
        request_id: str,
        *,
        usage: dict | None,
        status: int | None,
        error: str | None = None,
    ) -> dict:
        # Native SDK output includes hidden reasoning on supported providers;
        # the transport normalizer must not double-add reasoning to that total.
        actual = None
        if isinstance(usage, dict) and isinstance(usage.get("output"), (int, float)):
            actual = max(0, int(usage["output"]))
        with self.store.transaction() as db:
            row = db.execute(
                "SELECT * FROM execution_requests WHERE id=?", (request_id,)
            ).fetchone()
            if not row or row["session_id"] != session_id:
                raise PermissionError("Unknown request owner")
            if row["finished_at"] is not None:
                return {"ok": True, "duplicate": True}
            state = "completed" if actual is not None else "failed" if error else "usage_unknown"
            # Missing usage retains its original reservation. A provider error
            # does not prove it performed no generation or charged zero tokens.
            if actual is not None:
                db.execute(
                    "UPDATE execution_roots SET output_reserved=output_reserved+? WHERE id=?",
                    (actual - row["reserved"], row["root_id"]),
                )
            db.execute(
                "UPDATE execution_requests SET finished_at=?,state=?,status=?,usage_json=?,error=? WHERE id=?",
                (
                    now_ms(),
                    state,
                    status,
                    json.dumps(usage) if usage is not None else None,
                    str(error)[:1000] if error else None,
                    request_id,
                ),
            )
        return {"ok": True, "state": state}

    def claim_review(self, root_id: str, change_id: str, owner: str) -> bool:
        with self.store.transaction() as db:
            return (
                db.execute(
                    "INSERT OR IGNORE INTO execution_review_claims(root_id,change_id,owner) VALUES(?,?,?)",
                    (root_id, change_id, owner),
                ).rowcount
                == 1
            )

    def summary(self, root_id: str | None = None) -> dict:
        query = "SELECT * FROM execution_requests"
        args = ()
        if root_id:
            query += " WHERE root_id=?"
            args = (root_id,)
        totals = {key: 0 for key in ("input", "output", "reasoning", "cacheRead", "cacheWrite")}
        by_model = {}
        unknown = 0
        with self.store.connect() as db:
            rows = db.execute(query, args).fetchall()
        for row in rows:
            usage = json.loads(row["usage_json"]) if row["usage_json"] else {}
            if "output" not in usage:
                unknown += 1
            model = by_model.setdefault(
                row["model_ref"] or "unknown", {"calls": 0, **{key: 0 for key in totals}}
            )
            model["calls"] += 1
            for key in totals:
                value = usage.get(key)
                if isinstance(value, (int, float)):
                    totals[key] += value
                    model[key] += value
        return {
            "requests": len(rows),
            "usageUnknownRequests": unknown,
            "knownUsage": totals,
            "byModel": by_model,
            "cost": None,
            "costReason": "Provider charges are not inferred from reservations",
            "reasoningIncludedInOutput": True,
        }
