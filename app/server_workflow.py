#!/usr/bin/env python3
"""Production web entrypoint composing RAG, workflow, runtime and permissions."""
from __future__ import annotations

import json
from urllib.parse import quote, urlsplit

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


class Handler(rag.Handler, features.Handler):
    """V3/runtime/control routes first, then RAG/workflow/base proxy routes."""

    def json_response(self, value: object, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
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
