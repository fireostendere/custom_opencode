"""Durable, atomic budgets shared by a native turn and all of its subagents.

Reservations are not provider charges. Missing/ambiguous usage stays unknown,
with the reservation retained, instead of inventing zero spend or retrying.
"""

from __future__ import annotations
import hashlib
import json
import os
import uuid
from typing import Any
from runtime_store import RuntimeStore, now_ms

DEFAULT_LIMITS = {
    "calls": 128,
    "outputTokens": 1048576,
    "toolAttempts": 1024,
    "seconds": 7200,
    "finishTokens": 4096,
}
APPROVAL_TTL_MS = 15 * 60 * 1000
EXECUTION_INCREMENT_KEYS = ("calls", "outputTokens", "toolAttempts", "seconds")


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
                CREATE TABLE IF NOT EXISTS budget_approvals(
                    subject TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL,
                    proposal_json TEXT NOT NULL, form_id TEXT, state TEXT NOT NULL,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                    PRIMARY KEY(subject,kind,proposal_json));
                CREATE TABLE IF NOT EXISTS budget_approval_requests(
                    request_id TEXT PRIMARY KEY, subject TEXT NOT NULL, kind TEXT NOT NULL,
                    proposal_json TEXT NOT NULL, created_at INTEGER NOT NULL);
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

    def approval_owner(self, session_id: str) -> str:
        binding = self.binding(session_id)
        if not binding:
            return ""
        with self.store.connect() as db:
            root = db.execute("SELECT session_id FROM execution_roots WHERE id=?", (binding["root_id"],)).fetchone()
        owner = self.binding(root["session_id"]) if root else None
        return root["session_id"] if owner and owner["root_id"] == binding["root_id"] else ""

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

    @staticmethod
    def _form(features: Any, method: str, path: str, payload: dict | None = None) -> Any:
        return features._data(features._backend_request_json(method, path, payload, timeout=10.0))

    @staticmethod
    def _encoded(proposal: dict) -> str:
        return json.dumps(proposal, sort_keys=True, separators=(",", ":"))

    @staticmethod
    def _positive_int(value: Any) -> int | None:
        return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None

    @classmethod
    def _execution_increment(cls, proposal: dict) -> dict[str, int] | None:
        amount = proposal.get("increment") if isinstance(proposal, dict) else None
        if not isinstance(amount, dict) or set(amount) != set(EXECUTION_INCREMENT_KEYS):
            return None
        values = {key: cls._positive_int(amount.get(key)) for key in EXECUTION_INCREMENT_KEYS}
        return values if all(values.values()) else None

    @staticmethod
    def _cancel_form(features: Any, session_id: str, form_id: str | None) -> None:
        if not form_id:
            return
        try:
            ExecutionLedger._form(features, "POST", f"/api/session/{session_id}/form/{form_id}/cancel", {})
        except Exception:
            pass

    @staticmethod
    def _approval_description(kind: str, proposal: dict, reason: str = "") -> str:
        if kind == "execution":
            amount = proposal.get("increment") or {}
            seconds = amount.get("seconds", 0)
            deadline = "2h" if seconds == 7200 else f"{seconds} seconds"
            return ("Approve exactly one extension: +{calls} model calls, +{tools} tool attempts, "
                    "+{output} output tokens. The root time deadline extends to at least {deadline} "
                    "after approval. No future extensions are approved.").format(
                calls=amount.get("calls", 0), tools=amount.get("toolAttempts", 0),
                output=amount.get("outputTokens", 0), deadline=deadline)
        suffix = f" Reason: {reason[:200]}" if reason else ""
        return f"Approve exactly one context working-budget target of {proposal.get('workingTokens', 0)} tokens. This is a fresh one-time human approval; no future expansion is approved.{suffix}"

    def approval(self, features: Any, *, session_id: str, subject: str, kind: str, proposal: dict, reason: str = "") -> dict:
        """Create/poll an exact native-form proposal; never trusts caller approval."""
        encoded = self._encoded(proposal)
        creator = False
        form_id = None
        cancel_form = None
        with self.store.transaction() as db:
            row = db.execute("SELECT * FROM budget_approvals WHERE subject=? AND kind=? AND proposal_json=?", (subject, kind, encoded)).fetchone()
            if not row:
                form_id = "frm_" + uuid.uuid4().hex
                created = now_ms()
                # Persist the generated form identity before the native API can
                # render it, so the web proxy never sees an unprotected gap.
                db.execute("INSERT INTO budget_approvals VALUES(?,?,?,?,?,'creating',?,?)", (subject, session_id, kind, encoded, form_id, created, created))
                row = db.execute("SELECT * FROM budget_approvals WHERE subject=? AND kind=? AND proposal_json=?", (subject, kind, encoded)).fetchone()
            if row["session_id"] != session_id:
                raise PermissionError("Budget approval session mismatch")
            state, form_id = row["state"], row["form_id"]
            if state in {"pending", "approved"} and now_ms() - int(row["created_at"]) > APPROVAL_TTL_MS:
                if db.execute("UPDATE budget_approvals SET state='expired',updated_at=? WHERE subject=? AND kind=? AND proposal_json=? AND state IN ('pending','approved')", (now_ms(), subject, kind, encoded)).rowcount:
                    cancel_form = form_id if state == "pending" else None
                state = "expired"
            elif state == "creating":
                creator = db.execute("UPDATE budget_approvals SET state='posting',updated_at=? WHERE subject=? AND kind=? AND proposal_json=? AND state='creating'", (now_ms(), subject, kind, encoded)).rowcount == 1
                state = "posting"
        if cancel_form:
            self._cancel_form(features, session_id, cancel_form)
        if state == "expired":
            return {"state": "expired", "granted": False, "formID": form_id}
        if creator:
            try:
                created = self._form(features, "POST", f"/api/session/{session_id}/form", {
                    "id": form_id,
                    "title": "Approve one budget extension",
                    "metadata": {"budgetKind": kind, "proposal": proposal},
                    "fields": [{"key": "decision", "type": "string", "title": "Budget extension", "description": self._approval_description(kind, proposal, reason), "required": True, "options": [{"value": "approve", "label": "Approve once"}, {"value": "reject", "label": "Reject"}], "custom": False}],
                })
                returned_id = str((created or {}).get("id") or "")
                returned_session = (created or {}).get("sessionID") or (created or {}).get("session_id")
                if returned_id != form_id or (returned_session is not None and str(returned_session) != session_id):
                    raise RuntimeError("native form identity mismatch")
                with self.store.transaction() as db:
                    if db.execute("UPDATE budget_approvals SET state='pending',updated_at=? WHERE subject=? AND kind=? AND proposal_json=? AND form_id=? AND state='posting'", (now_ms(), subject, kind, encoded, form_id)).rowcount != 1:
                        raise RuntimeError("native form creation state lost")
                state = "pending"
            except Exception:
                with self.store.transaction() as db:
                    db.execute("UPDATE budget_approvals SET state='unavailable',updated_at=? WHERE subject=? AND kind=? AND proposal_json=? AND state='posting'", (now_ms(), subject, kind, encoded))
                return {"state": "unavailable", "granted": False}
        if state == "posting":
            return {"state": "creating", "granted": False}
        if state == "pending" and form_id:
            if now_ms() - int(row["created_at"]) > APPROVAL_TTL_MS:
                with self.store.transaction() as db:
                    expired = db.execute("UPDATE budget_approvals SET state='expired',updated_at=? WHERE subject=? AND kind=? AND proposal_json=? AND state='pending'", (now_ms(), subject, kind, encoded)).rowcount
                if expired:
                    self._cancel_form(features, session_id, form_id)
                return {"state": "expired", "granted": False, "formID": form_id}
            try:
                remote = self._form(features, "GET", f"/api/session/{session_id}/form/{form_id}/state")
                status = str((remote or {}).get("status") or "")
                answer = (remote or {}).get("answer") or {}
                new_state = "approved" if status == "answered" and answer.get("decision") == "approve" else "denied" if status in {"answered", "cancelled"} else "pending"
                with self.store.transaction() as db:
                    db.execute("UPDATE budget_approvals SET state=?,updated_at=? WHERE subject=? AND kind=? AND proposal_json=? AND state='pending'", (new_state, now_ms(), subject, kind, encoded))
                    actual = db.execute("SELECT state FROM budget_approvals WHERE subject=? AND kind=? AND proposal_json=?", (subject, kind, encoded)).fetchone()
                state = actual["state"] if actual else new_state
            except Exception:
                return {"state": "unavailable", "granted": False}
        return {"state": state, "granted": state in {"approved", "consumed"}, "formID": form_id}

    def extension_status(self, session_id: str) -> dict:
        """Pure observation: no form creation, polling, consumption, or grant."""
        return {"granted": False, "state": "status", "budget": self.snapshot(session_id)}

    def _next_execution_proposal(self, db: Any, subject: str, *, explicit: bool) -> dict:
        rows = db.execute("SELECT proposal_json,state FROM budget_approvals WHERE subject=? AND kind='execution' ORDER BY created_at DESC,rowid DESC", (subject,)).fetchall()
        revision = 0
        for row in rows:
            try:
                parsed = json.loads(row["proposal_json"])
                value = parsed.get("revision")
                if isinstance(value, int) and not isinstance(value, bool):
                    revision = max(revision, value)
            except (TypeError, ValueError, json.JSONDecodeError):
                pass
        if rows:
            latest = rows[0]
            try:
                proposal = json.loads(latest["proposal_json"])
            except (TypeError, ValueError, json.JSONDecodeError):
                proposal = None
            terminal = {"denied", "expired", "unavailable"}
            if isinstance(proposal, dict) and latest["state"] != "consumed" and not (explicit and latest["state"] in terminal):
                return proposal
        return {
            "increment": {key: DEFAULT_LIMITS[key] for key in EXECUTION_INCREMENT_KEYS},
            "revision": revision + 1,
        }

    def extension_request(self, features: Any, session_id: str, request_id: str, *, explicit: bool = False) -> dict:
        if not request_id or len(request_id) > 256:
            raise ValueError("requestID required")
        with self.store.transaction() as db:
            binding = db.execute("SELECT * FROM execution_bindings WHERE session_id=?", (session_id,)).fetchone()
            if not binding:
                raise PermissionError("Native session is not bound to an execution budget")
            root = db.execute("SELECT * FROM execution_roots WHERE id=?", (binding["root_id"],)).fetchone()
            owner = db.execute("SELECT * FROM execution_bindings WHERE session_id=?", (root["session_id"],)).fetchone() if root else None
            if not root or not owner or owner["root_id"] != binding["root_id"]:
                return {"granted": False, "state": "stale", "requestID": request_id}
            request = db.execute("SELECT * FROM budget_approval_requests WHERE request_id=?", (request_id,)).fetchone()
            if request:
                if request["subject"] != binding["root_id"] or request["kind"] != "execution":
                    raise PermissionError("Budget request ID owner mismatch")
                proposal = json.loads(request["proposal_json"])
            else:
                proposal = self._next_execution_proposal(db, binding["root_id"], explicit=explicit)
                db.execute("INSERT INTO budget_approval_requests VALUES(?,?,?,?,?)", (request_id, binding["root_id"], "execution", self._encoded(proposal), now_ms()))
            approval_session = root["session_id"]
            subject = binding["root_id"]
        return {**self.approval(features, session_id=approval_session, subject=subject, kind="execution", proposal=proposal), "requestID": request_id}

    def extension_check(self, features: Any, session_id: str, request_id: str) -> dict:
        with self.store.connect() as db:
            binding = db.execute("SELECT * FROM execution_bindings WHERE session_id=?", (session_id,)).fetchone()
            if not binding:
                raise PermissionError("Native session is not bound to an execution budget")
            request = db.execute("SELECT * FROM budget_approval_requests WHERE request_id=?", (request_id,)).fetchone()
            if request and (request["subject"] != binding["root_id"] or request["kind"] != "execution"):
                raise PermissionError("Budget request ID owner mismatch")
            root = db.execute("SELECT * FROM execution_roots WHERE id=?", (binding["root_id"],)).fetchone()
            owner = db.execute("SELECT * FROM execution_bindings WHERE session_id=?", (root["session_id"],)).fetchone() if root else None
        if not request or not root:
            return {"granted": False, "state": "unknown", "requestID": request_id}
        if not owner or owner["root_id"] != binding["root_id"]:
            return {"granted": False, "state": "stale", "requestID": request_id}
        return {**self.approval(features, session_id=root["session_id"], subject=binding["root_id"], kind="execution", proposal=json.loads(request["proposal_json"])), "requestID": request_id}

    def extension_apply(self, session_id: str, request_id: str) -> dict:
        with self.store.transaction() as db:
            binding = db.execute("SELECT * FROM execution_bindings WHERE session_id=?", (session_id,)).fetchone()
            if not binding:
                raise PermissionError("Native session is not bound to an execution budget")
            request = db.execute("SELECT * FROM budget_approval_requests WHERE request_id=?", (request_id,)).fetchone()
            if request and (request["subject"] != binding["root_id"] or request["kind"] != "execution"):
                raise PermissionError("Budget request ID owner mismatch")
            root = db.execute("SELECT * FROM execution_roots WHERE id=?", (binding["root_id"],)).fetchone()
            current = db.execute("SELECT * FROM execution_bindings WHERE session_id=?", (root["session_id"],)).fetchone() if root else None
            if not request or not root or not current or current["root_id"] != binding["root_id"]:
                return {"granted": False, "state": "stale", "requestID": request_id}
            approval = db.execute("SELECT * FROM budget_approvals WHERE subject=? AND session_id=? AND kind='execution' AND proposal_json=?", (binding["root_id"], root["session_id"], request["proposal_json"])).fetchone()
            if not approval:
                return {"granted": False, "state": "unknown", "requestID": request_id}
            if approval["state"] == "approved" and now_ms() - int(approval["created_at"]) > APPROVAL_TTL_MS:
                db.execute("UPDATE budget_approvals SET state='expired',updated_at=? WHERE subject=? AND kind='execution' AND proposal_json=? AND state='approved'", (now_ms(), binding["root_id"], request["proposal_json"]))
                return {"granted": False, "state": "expired", "requestID": request_id}
            if approval["state"] == "consumed":
                return {"granted": True, "state": "granted", "requestID": request_id, "budget": self.snapshot(session_id)}
            if approval["state"] != "approved":
                return {"granted": False, "state": approval["state"] if approval else "unknown", "requestID": request_id}
            proposal = json.loads(request["proposal_json"])
            increment = self._execution_increment(proposal)
            if not increment:
                return {"granted": False, "state": "invalid", "requestID": request_id}
            limits = json.loads(root["limits_json"])
            for key, value in increment.items():
                limits[key] += value
            elapsed_seconds = max(0, (now_ms() - root["started_at"]) // 1000)
            limits["seconds"] = max(limits["seconds"], elapsed_seconds + increment["seconds"])
            consumed = db.execute("UPDATE budget_approvals SET state='consumed',updated_at=? WHERE subject=? AND kind='execution' AND proposal_json=? AND state='approved'", (now_ms(), binding["root_id"], request["proposal_json"])).rowcount
            if not consumed:
                return {"granted": False, "state": "stale", "requestID": request_id}
            # finishTokens is the internal completion reserve, not another public
            # tranche. The extra output budget above already covers this grant.
            db.execute("UPDATE execution_roots SET limits_json=?,finish_used=0 WHERE id=?", (json.dumps(limits), binding["root_id"]))
        return {"granted": True, "state": "granted", "requestID": request_id, "budget": self.snapshot(session_id)}

    def consume_context_approval(self, *, session_id: str, subject: str, proposal: dict, state: dict, ceiling: int, max_steps: int, model: str) -> bool:
        """Consume and persist one context grant in the same SQLite transaction."""
        target = self._positive_int(proposal.get("workingTokens") if isinstance(proposal, dict) else None)
        valid_limit = self._positive_int(ceiling)
        valid_steps = self._positive_int(max_steps)
        proposal_model = proposal.get("model") if isinstance(proposal, dict) else None
        proposal_root = proposal.get("rootID") if isinstance(proposal, dict) else None
        proposal_session = proposal.get("sessionID") if isinstance(proposal, dict) else None
        if (
            not target
            or not valid_limit
            or not valid_steps
            or target > valid_limit
            or not isinstance(proposal_model, str)
            or not proposal_model
            or proposal_model != model
            or not isinstance(proposal_root, str)
            or not proposal_root
            or not isinstance(proposal_session, str)
            or not proposal_session
            or proposal.get("ceilingTokens") != valid_limit
            or proposal.get("maxSteps") != valid_steps
            or subject != f"context:{proposal_session}"
        ):
            return False
        encoded = self._encoded(proposal)

        def counter(value: Any) -> int:
            return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0

        with self.store.transaction() as db:
            binding = db.execute("SELECT * FROM execution_bindings WHERE session_id=?", (proposal_session,)).fetchone()
            root = db.execute("SELECT * FROM execution_roots WHERE id=?", (proposal_root,)).fetchone()
            owner = db.execute("SELECT * FROM execution_bindings WHERE session_id=?", (root["session_id"],)).fetchone() if root else None
            approval = db.execute("SELECT * FROM budget_approvals WHERE subject=? AND session_id=? AND kind='context' AND proposal_json=?", (subject, session_id, encoded)).fetchone()
            if (
                not binding
                or not root
                or not owner
                or root["session_id"] != session_id
                or owner["root_id"] != proposal_root
                or binding["root_id"] != proposal_root
                or binding["model_ref"] != proposal_model
                or not approval
            ):
                return False
            row = db.execute("SELECT value_json FROM cache WHERE namespace='context-budget' AND cache_key=?", (proposal_session,)).fetchone()
            try:
                old = json.loads(row["value_json"]) if row else {}
            except (TypeError, ValueError, json.JSONDecodeError):
                old = {}
            if not isinstance(old, dict) or old.get("rootID") != proposal_root or old.get("model") != proposal_model:
                old = {}
            old_working = min(valid_limit, counter(old.get("workingTokens")))
            old_steps = counter(old.get("steps"))
            if approval["state"] == "consumed":
                # A replay only proves the already-recorded grant. It never
                # recreates state or increments a counter after consumption.
                return old_working >= target and old_steps <= valid_steps
            if approval["state"] != "approved":
                return False
            stamp = now_ms()
            if stamp - int(approval["created_at"]) > APPROVAL_TTL_MS:
                db.execute("UPDATE budget_approvals SET state='expired',updated_at=? WHERE subject=? AND session_id=? AND kind='context' AND proposal_json=? AND state='approved'", (stamp, subject, session_id, encoded))
                return False
            grows = target > old_working
            if grows and old_steps >= valid_steps:
                db.execute("UPDATE budget_approvals SET state='denied',updated_at=? WHERE subject=? AND session_id=? AND kind='context' AND proposal_json=? AND state='approved'", (stamp, subject, session_id, encoded))
                return False
            consumed = db.execute("UPDATE budget_approvals SET state='consumed',updated_at=? WHERE subject=? AND session_id=? AND kind='context' AND proposal_json=? AND state='approved'", (stamp, subject, session_id, encoded)).rowcount
            if not consumed:
                return False
            if grows:
                saved = {
                    **old,
                    **state,
                    "workingTokens": target,
                    "requestedTokens": max(counter(old.get("requestedTokens")), target),
                    "steps": old_steps + 1,
                    "grantedAt": stamp,
                    "rootID": proposal_root,
                    "model": proposal_model,
                }
                db.execute("INSERT OR REPLACE INTO cache(namespace,cache_key,value_json,expires_at,updated_at) VALUES(?,?,?,?,?)", ("context-budget", proposal_session, json.dumps(saved), stamp + 604800000, stamp))
        return True

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
