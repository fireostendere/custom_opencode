#!/usr/bin/env python3
"""Permission control-plane integration for the persistent workflow server."""
from __future__ import annotations

import threading
from typing import Any
from urllib.parse import parse_qs

import control_plane
import server_features as features

ACTION_LOCK = threading.RLock()
INFLIGHT: set[str] = set()


def _request_id(request: dict[str, Any]) -> str:
    return str(request.get("requestID") or request.get("id") or "")


def _session_id(request: dict[str, Any]) -> str:
    return str(request.get("sessionID") or "")


def _project_rule(directory: str, request: dict[str, Any]) -> dict[str, str] | None:
    try:
        settings = features.project_settings(directory)
    except Exception:
        return None
    for rule in settings.get("permissionRules") or []:
        if not isinstance(rule, dict):
            continue
        normalized = features._sanitize_rule(rule)
        if normalized and features._rule_matches(normalized, request):
            return normalized
    return None


def decision_for(request: dict[str, Any], directory: str) -> dict[str, Any]:
    decision = control_plane.classify_permission(request, workspace=directory)
    rule = _project_rule(directory, request)
    if not rule:
        return decision

    effect = rule.get("effect") or "ask"
    decision["source"] = "project"
    decision["projectRule"] = rule
    if effect == "deny":
        decision.update(
            effect="deny",
            auto=True,
            reply="reject",
            reason=f"project deny rule matched; {decision.get('reason')}",
        )
        return decision
    if effect == "ask":
        decision.update(
            effect="ask",
            auto=False,
            reply=None,
            reason=f"project ask rule matched; {decision.get('reason')}",
        )
        return decision
    if effect == "allow" and control_plane.risk_at_most(str(decision.get("risk") or "R3"), "R2"):
        decision.update(
            effect="allow",
            auto=True,
            reply="once",
            reason=f"project allow rule matched within {decision.get('risk')} boundary",
        )
        return decision

    # A saved allow is never allowed to punch through the hard R3/R4 boundary.
    decision.update(
        effect="ask",
        auto=False,
        reply=None,
        reason=f"project allow rule matched but {decision.get('risk')} remains interactive",
    )
    return decision


def _actual_pending(session_id: str, permission_id: str | None = None) -> tuple[str, dict[str, Any] | None]:
    directory = features._session_directory(session_id)
    requests = features._permission_requests(directory)
    for request in requests:
        if _session_id(request) != session_id:
            continue
        if permission_id and _request_id(request) != permission_id:
            continue
        return directory, request
    return directory, None


def evaluate_permission(session_id: str, permission_id: str | None = None, *, auto_reply: bool = True) -> dict[str, Any]:
    try:
        directory, request = _actual_pending(session_id, permission_id)
    except Exception as exc:
        return {
            "ok": False,
            "autoReplied": False,
            "effect": "ask",
            "risk": "R3",
            "reason": f"permission lookup failed: {type(exc).__name__}: {exc}",
        }
    if request is None:
        return {
            "ok": True,
            "stale": True,
            "autoReplied": False,
            "effect": "ask",
            "risk": None,
            "reason": "permission is no longer pending",
        }

    pid = _request_id(request)
    sid = _session_id(request)
    decision = decision_for(request, directory)
    result: dict[str, Any] = {"ok": True, "autoReplied": False, "permissionID": pid, **decision}
    if not auto_reply or not decision.get("auto") or decision.get("reply") not in {"once", "reject"}:
        return result

    key = f"{sid}:{pid}"
    with ACTION_LOCK:
        if key in INFLIGHT:
            result["busy"] = True
            return result
        INFLIGHT.add(key)
    try:
        features._permission_reply(request, str(decision["reply"]))
        result["autoReplied"] = True
        control_plane.audit_decision(
            decision,
            request=request,
            session_id=sid,
            permission_id=pid,
            outcome="replied",
        )
    except Exception as exc:
        result["ok"] = False
        result["error"] = f"auto-reply failed: {type(exc).__name__}: {exc}"
        control_plane.audit_decision(
            decision,
            request=request,
            session_id=sid,
            permission_id=pid,
            outcome="reply-failed",
        )
    finally:
        with ACTION_LOCK:
            INFLIGHT.discard(key)
    return result


def _known_directories() -> list[str]:
    directories: set[str] = set()
    try:
        sessions = features._data(features._backend_request_json("GET", "/api/session", timeout=8.0))
        if isinstance(sessions, list):
            for session in sessions[:500]:
                if not isinstance(session, dict):
                    continue
                raw = ((session.get("location") or {}).get("directory"))
                if not isinstance(raw, str) or not raw:
                    continue
                try:
                    directories.add(features._canonical_directory(raw))
                except Exception:
                    continue
    except Exception:
        pass

    try:
        state = features._with_state_read()
        projects = state.get("projects") if isinstance(state.get("projects"), dict) else {}
        for raw in projects:
            try:
                directories.add(features._canonical_directory(str(raw)))
            except Exception:
                continue
    except Exception:
        pass
    return sorted(directories)


def apply_permission_policies() -> None:
    """Worker hook replacing the old rule-only automation.

    It evaluates actual pending backend requests. Project rules are composed
    with the global risk classifier; the browser never supplies action/resource
    data for automatic permission decisions.
    """
    for directory in _known_directories():
        try:
            requests = features._permission_requests(directory)
        except Exception:
            continue
        for request in requests:
            sid = _session_id(request)
            pid = _request_id(request)
            if not sid or not pid:
                continue
            decision = decision_for(request, directory)
            if not decision.get("auto") or decision.get("reply") not in {"once", "reject"}:
                continue
            key = f"{sid}:{pid}"
            with ACTION_LOCK:
                if key in INFLIGHT:
                    continue
                INFLIGHT.add(key)
            try:
                features._permission_reply(request, str(decision["reply"]))
                control_plane.audit_decision(
                    decision,
                    request=request,
                    session_id=sid,
                    permission_id=pid,
                    outcome="replied",
                )
            except Exception:
                control_plane.audit_decision(
                    decision,
                    request=request,
                    session_id=sid,
                    permission_id=pid,
                    outcome="reply-failed",
                )
            finally:
                with ACTION_LOCK:
                    INFLIGHT.discard(key)


def snapshot() -> dict[str, Any]:
    value = control_plane.snapshot()
    value["workflowIntegration"] = {
        "worker": "server_features background worker",
        "projectRules": True,
        "clientSuppliedActionData": False,
        "hardInteractiveBoundary": ["R3", "R4"],
    }
    return value


def handle_get(handler: Any, parsed: Any) -> bool:
    if parsed.path == "/client-control-plane.json":
        if not handler.authenticated():
            return True
        handler.json_response(snapshot())
        return True
    if parsed.path == "/client-permission-risk.json":
        if not handler.authenticated():
            return True
        params = parse_qs(parsed.query)
        session_id = str((params.get("sessionID") or [""])[0])
        if not session_id or len(session_id) > 256:
            handler.json_response({"ok": False, "error": "invalid session id"}, status=400)
            return True
        handler.json_response(evaluate_permission(session_id, auto_reply=False))
        return True
    return False


def handle_post(handler: Any, parsed: Any) -> bool:
    if parsed.path != "/client-permission-evaluate.json":
        return False
    if not handler.authenticated():
        return True
    try:
        payload = handler._feature_body(4096)
        session_id = str(payload.get("sessionID") or "")
        permission_id = str(payload.get("permissionID") or "")
        if not session_id or len(session_id) > 256:
            raise ValueError("invalid session id")
        if not permission_id or len(permission_id) > 256:
            raise ValueError("invalid permission id")
        handler.json_response(evaluate_permission(session_id, permission_id, auto_reply=True))
    except Exception as exc:
        handler._feature_error(exc)
    return True


def install() -> None:
    # server_features owns the single background worker. Replace only its
    # permission pass; queue dispatch and every other workflow responsibility
    # remain unchanged.
    features._apply_permission_policies = apply_permission_policies
