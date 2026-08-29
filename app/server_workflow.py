#!/usr/bin/env python3
"""Production web entrypoint composing RAG and advanced workflow features."""
from __future__ import annotations

import json
from urllib.parse import quote, urlsplit

import server_features as features
import server_rag as rag


_ORIGINAL_SEND = features._send_backend_prompt


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
    """Prefer the async message API so project instructions remain system-only."""
    directory = features._session_directory(session_id)
    settings = features.project_settings(directory)
    instructions = str(settings.get("instructions") or "").strip()
    target = f"/api/session/{quote(session_id, safe='')}/prompt_async"
    parts: list[dict[str, object]] = []
    if text:
        parts.append({"type": "text", "text": text})
    parts.extend(_file_parts(files))
    payload: dict[str, object] = {"parts": parts}
    if instructions:
        payload["system"] = (
            "Project-specific persistent instructions configured by the user for this workspace. "
            "Treat them as project policy unless they conflict with higher-priority instructions.\n\n"
            + instructions
        )
    try:
        return features._backend_request_json("POST", target, payload, timeout=30.0)
    except features.BackendHTTPError as exc:
        if exc.status not in (400, 404, 405, 422):
            raise
    # Compatibility fallback for the repository's pinned V2 build. This path
    # still preserves queue delivery even if the newer `system` field is not available.
    return _ORIGINAL_SEND(session_id, text, files)


features._send_backend_prompt = _send_with_project_context


class Handler(rag.Handler, features.Handler):
    """RAG routes first, then persistent workflow routes, then the base proxy."""

    def json_response(self, value: object, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        parsed = urlsplit(self.path)
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
                profile = str(payload.get("profile") or "direct")
                route = None
                if profile == "auto":
                    route = features.auto_route(session_id, apply=True)
                result = _send_with_project_context(session_id, text, files)
                self.json_response({"ok": True, "route": route, "result": result})
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
