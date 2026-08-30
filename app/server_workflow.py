#!/usr/bin/env python3
"""Production web entrypoint composing RAG, workflow, runtime and permissions."""
from __future__ import annotations

import hashlib
import json
import secrets
import threading
import time
from urllib.parse import quote, urlsplit

import integration_contract
import runtime_completion
import runtime_resume
import runtime_v3
import runtime_v3_ext
import server_control as control
import server_features as features
import server_rag as rag
import server_runtime as runtime


_ORIGINAL_SEND = features._send_backend_prompt
runtime.install(features)
runtime_v3.install(runtime, features)
runtime_v3_ext.install(runtime, runtime_v3, features)
control.install()
runtime_completion.install(runtime, runtime_v3, control, features)

# Web auth hardening lives at the production composition layer so every
# production route (base proxy, workflow, RAG and Runtime V3) shares exactly
# the same decision. The low-level server.py remains usable for isolated
# component tests, while server_workflow.py is the systemd entrypoint.
_LOGIN_WINDOW_SECONDS = 60.0
_LOGIN_MAX_FAILURES = 8
_login_lock = threading.Lock()
_login_failures: dict[str, list[float]] = {}
_revoked_lock = threading.Lock()
_revoked_tokens: dict[str, float] = {}


def _file_parts(files: list[object]) -> list[dict[str, object]]:
    parts: list[dict[str, object]] = []
    for item in files:
        if not isinstance(item, dict):
            continue
        url = item.get("uri") or item.get("url")
        if not isinstance(url, str) or not url:
            continue
        part: dict[str, object] = {"type": "file", "url": url}
        if item.get("name"):
            part["filename"] = str(item["name"])
        if item.get("mime"):
            part["mime"] = str(item["mime"])
        parts.append(part)
    return parts


def _send_with_project_context(session_id: str, text: str, files: list[object]) -> object:
    """Prefer async prompt with native compaction, shared RAG and checkpoint-aware resume."""
    directory = features._session_directory(session_id)
    settings = features.project_settings(directory)
    instructions = str(settings.get("instructions") or "").strip()
    envelope = runtime_v3.context_envelope(
        features,
        runtime,
        session_id,
        instructions,
        str(settings.get("rag") or "auto"),
    )
    context = str(envelope.get("text") or "").strip()
    effective_text, effective_files, resume = runtime_resume.continuation_payload(runtime.STORE, session_id, text, list(files))
    if resume:
        runtime.STORE.event(
            kind="task.resume_continuation",
            task_id=str(resume.get("taskID") or "") or None,
            session_id=session_id,
            project_dir=directory,
            data=resume,
        )
    target = f"/api/session/{quote(session_id, safe='')}/prompt_async"
    parts: list[dict[str, object]] = []
    if effective_text:
        parts.append({"type": "text", "text": effective_text})
    parts.extend(_file_parts(effective_files))
    body: dict[str, object] = {"parts": parts}
    if context:
        body["system"] = (
            "Server runtime context (deduplicated, budgeted, checkpoint/RAG/repo aware). "
            "It may include project policy, durable decisions, semantic symbol diff, structured mailbox/handoff, "
            "repository index matches and server-managed engineering RAG. Use it as project/task context unless "
            "it conflicts with higher-priority instructions.\n\n" + context
        )
    try:
        return features._backend_request_json("POST", target, body, timeout=30.0)
    except features.BackendHTTPError as exc:
        if exc.status not in (400, 404, 405, 422):
            raise
    return _ORIGINAL_SEND(session_id, effective_text, effective_files)


features._send_backend_prompt = _send_with_project_context


def _request_identity(handler: object) -> str:
    """Stable login-throttle key without trusting arbitrary remote headers."""
    base = rag.plus.ext.base
    peer = str(getattr(handler, "client_address", ("unknown",))[0])
    if base.is_loopback(peer):
        # Forwarded client IP is considered only when the actual TCP peer is
        # loopback (the supported local reverse-proxy deployment). A directly
        # exposed remote client cannot spoof its throttle bucket with XFF.
        forwarded = str(handler.headers.get("X-Forwarded-For", "")).split(",", 1)[0].strip()
        if forwarded:
            return f"proxy:{forwarded}"
    return f"peer:{peer}"


def _login_limited(key: str, now: float | None = None) -> bool:
    now = time.monotonic() if now is None else now
    cutoff = now - _LOGIN_WINDOW_SECONDS
    with _login_lock:
        recent = [stamp for stamp in _login_failures.get(key, []) if stamp >= cutoff]
        if recent:
            _login_failures[key] = recent
        else:
            _login_failures.pop(key, None)
        return len(recent) >= _LOGIN_MAX_FAILURES


def _record_login_failure(key: str) -> None:
    now = time.monotonic()
    cutoff = now - _LOGIN_WINDOW_SECONDS
    with _login_lock:
        recent = [stamp for stamp in _login_failures.get(key, []) if stamp >= cutoff]
        recent.append(now)
        _login_failures[key] = recent[-_LOGIN_MAX_FAILURES:]


def _clear_login_failures(key: str) -> None:
    with _login_lock:
        _login_failures.pop(key, None)


def _token_fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8", errors="replace")).hexdigest()


def _prune_revocations(now: float | None = None) -> None:
    now = time.time() if now is None else now
    with _revoked_lock:
        for key, expires_at in list(_revoked_tokens.items()):
            if expires_at <= now:
                _revoked_tokens.pop(key, None)


def _revoke_token(token: str) -> None:
    if not token:
        return
    base = rag.plus.ext.base
    _prune_revocations()
    with _revoked_lock:
        _revoked_tokens[_token_fingerprint(token)] = time.time() + float(base.AUTH_REMEMBER_SECONDS)


def _token_revoked(token: str) -> bool:
    if not token:
        return False
    _prune_revocations()
    with _revoked_lock:
        return _token_fingerprint(token) in _revoked_tokens


class Handler(rag.Handler, features.Handler):
    """V3/runtime/control routes first, then RAG/workflow/base proxy routes."""

    def json_response(self, value: object, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def local_bypass(self) -> bool:
        """Allow passwordless loopback only for a direct localhost request.

        A local reverse proxy also connects from 127.0.0.1, so trusting the TCP
        peer alone turns every proxied LAN/Tailscale request into localhost.
        Forwarding headers or a non-loopback Host therefore disable bypass.
        """
        base = rag.plus.ext.base
        if not base.ALLOW_LOCAL or not base.is_loopback(self.client_address[0]):
            return False
        if any(
            self.headers.get(name)
            for name in ("Forwarded", "X-Forwarded-For", "X-Real-IP", "X-Forwarded-Proto")
        ):
            return False
        host_header = str(self.headers.get("Host", "")).strip()
        try:
            host = urlsplit(f"//{host_header}").hostname or ""
        except ValueError:
            return False
        return base.is_loopback(host)

    def authenticated(self) -> bool:
        base = rag.plus.ext.base
        if self.local_bypass():
            return True
        token = self.cookie_token()
        if token and not _token_revoked(token) and base.valid_session_token(token):
            return True
        if base.ALLOW_BASIC_AUTH:
            supplied = self.headers.get("Authorization", "")
            if supplied and secrets.compare_digest(supplied, base.CLIENT_AUTH):
                return True
        return False

    def login(self) -> None:
        base = rag.plus.ext.base
        identity = _request_identity(self)
        if _login_limited(identity):
            self.json_response({"ok": False, "error": "Слишком много попыток входа"}, status=429)
            return
        payload = self.read_json_body()
        if payload is None:
            self.json_response({"ok": False, "error": "Некорректный запрос"}, status=400)
            return
        username = str(payload.get("username", ""))
        password = str(payload.get("password", ""))
        remember = bool(payload.get("remember", False))
        user_ok = secrets.compare_digest(username, base.CLIENT_USER)
        password_ok = secrets.compare_digest(password, base.CLIENT_PASSWORD)
        if not (user_ok and password_ok):
            _record_login_failure(identity)
            time.sleep(0.35)
            self.json_response({"ok": False, "error": "Неверный логин или пароль"}, status=401)
            return

        _clear_login_failures(identity)
        ttl = base.AUTH_REMEMBER_SECONDS if remember else base.AUTH_SESSION_SECONDS
        token = base.issue_session_token(ttl)
        self.send_response(204)
        self.send_header("Set-Cookie", self.session_cookie(token, remember=remember))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def logout(self) -> None:
        token = self.cookie_token()
        if token and rag.plus.ext.base.valid_session_token(token):
            _revoke_token(token)
        super().logout()

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/client-integration.json":
            if not self.authenticated():
                return
            self.json_response(integration_contract.contract())
            return
        if runtime_completion.handle_get(self, parsed, runtime, control, features):
            return
        if runtime_v3_ext.handle_get(self, parsed, runtime, runtime_v3, features):
            return
        if runtime_v3.handle_get(self, parsed, runtime, features):
            return
        if runtime.handle_get(self, parsed, features):
            return
        if control.handle_get(self, parsed):
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlsplit(self.path)
        if runtime_completion.handle_post(self, parsed, runtime, control, features):
            return
        if runtime_v3_ext.handle_post(self, parsed, runtime, runtime_v3, features):
            return
        if runtime_v3.handle_post(self, parsed, runtime, features):
            return
        if runtime.handle_post(self, parsed, features):
            return
        if control.handle_post(self, parsed):
            return
        if parsed.path == "/client-send.json":
            if not self.authenticated():
                return
            try:
                payload = self._feature_body()
                session_id = str(payload.get("sessionID") or "")
                if not session_id or len(session_id) > 256:
                    raise ValueError("invalid session id")
                text = str(payload.get("text") or "")
                files = payload.get("files") if isinstance(payload.get("files"), list) else []
                if not text.strip() and not files:
                    raise ValueError("empty message")
                result = runtime.dispatch_immediate(
                    features,
                    session_id=session_id,
                    text=text,
                    files=files,
                    profile=str(payload.get("profile") or payload.get("modelProfile") or "direct"),
                )
                self.json_response({"ok": True, **result})
            except Exception as exc:
                self._feature_error(exc)
            return
        super().do_POST()


def main() -> None:
    rag.plus.ext.base.SCRATCH_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    server = rag.plus.ext.base.ThreadingHTTPServer((rag.plus.ext.base.WEB_HOST, rag.plus.ext.base.WEB_PORT), Handler)
    features._ensure_worker()
    print(f"OpenCode web client started on configured port {rag.plus.ext.base.WEB_PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
