#!/usr/bin/env python3
"""Tiny same-origin proxy and static server for the OpenCode V2 web client."""

from __future__ import annotations

import base64
import http.client
import ipaddress
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import shutil
import sys
from urllib.parse import urlsplit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT = Path(__file__).resolve().parent
DEFAULT_SERVICE_FILE = Path.home() / ".local/state/opencode/service.json"
DEFAULT_LEGACY_AUTH_FILE = Path.home() / ".config/opencode/mobile-server.env"
SCRATCH_PROJECT_ID = "__custom_opencode_quick__"
SCRATCH_PROJECT_NAME = "Быстрые"
SESSION_DELETE_RE = re.compile(r"^/api/session/[^/]+$")


def read_env_file(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return result
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        result[key.strip()] = value
    return result


BASE_ENV = {
    **read_env_file(ROOT.parent / ".env"),
    **read_env_file(ROOT / ".env"),
}
_legacy_auth_value = os.environ.get("OPENCODE_LEGACY_AUTH_FILE") or BASE_ENV.get("OPENCODE_LEGACY_AUTH_FILE")
LEGACY_AUTH_FILE = Path(_legacy_auth_value).expanduser() if _legacy_auth_value else DEFAULT_LEGACY_AUTH_FILE
FILE_ENV = {
    **read_env_file(LEGACY_AUTH_FILE),
    **BASE_ENV,
}


def setting(name: str, default: str | None = None) -> str | None:
    return os.environ.get(name) or FILE_ENV.get(name) or default


_service_file_value = setting("OPENCODE_SERVICE_FILE", str(DEFAULT_SERVICE_FILE))
SERVICE_FILE = Path(_service_file_value).expanduser()


def is_loopback(value: str) -> bool:
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return value == "localhost"


def load_backend() -> tuple[str, str]:
    explicit_url = setting("OPENCODE_BACKEND_URL")
    explicit_password = setting("OPENCODE_BACKEND_PASSWORD")
    if explicit_url and explicit_password:
        return explicit_url.rstrip("/"), explicit_password

    try:
        service = json.loads(SERVICE_FILE.read_text(encoding="utf-8"))
        url = str(service["url"]).rstrip("/")
        password = str(service["password"])
        return url, password
    except (OSError, KeyError, TypeError, ValueError) as exc:
        raise SystemExit(f"Не найден V2 backend: {SERVICE_FILE}: {exc}") from exc


CLIENT_USER = setting("OPENCODE_SERVER_USERNAME", "opencode")
CLIENT_PASSWORD = setting("OPENCODE_SERVER_PASSWORD")
if not CLIENT_PASSWORD:
    raise SystemExit("Не задан OPENCODE_SERVER_PASSWORD в .env")

BACKEND_URL, BACKEND_PASSWORD = load_backend()
BACKEND_USER = setting("OPENCODE_BACKEND_USERNAME", "opencode")
BACKEND = urlsplit(BACKEND_URL)
if BACKEND.scheme != "http" or not BACKEND.hostname or BACKEND.path not in ("", "/"):
    raise SystemExit(f"Поддерживается только простой http backend: {BACKEND_URL}")

WEB_HOST = setting("OPENCODE_WEB_HOST", "localhost")
WEB_PORT = int(setting("OPENCODE_WEB_PORT", "4098"))
ALLOW_LOCAL = setting(
    "OPENCODE_WEB_ALLOW_LOCAL",
    "1" if is_loopback(WEB_HOST) else "0",
) not in ("0", "false", "no")
SCRATCH_ROOT = Path(setting("OPENCODE_SCRATCH_DIRECTORY", str(Path.home() / "opencode-scratch"))).expanduser().resolve()
SCRATCH_DIRECTORY = str(SCRATCH_ROOT)


def basic_value(user: str, password: str) -> str:
    value = f"{user}:{password}".encode("utf-8")
    return "Basic " + base64.b64encode(value).decode("ascii")


CLIENT_AUTH = basic_value(CLIENT_USER, CLIENT_PASSWORD)
BACKEND_AUTH = basic_value(BACKEND_USER, BACKEND_PASSWORD)
HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


def resolve_directory(value: object) -> Path | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return Path(value).expanduser().resolve(strict=False)
    except (OSError, RuntimeError):
        return None


def is_scratch_path(value: object, *, include_root: bool = True) -> bool:
    candidate = resolve_directory(value)
    if candidate is None:
        return False
    if candidate == SCRATCH_ROOT:
        return include_root
    return SCRATCH_ROOT in candidate.parents


def allocate_scratch_directory() -> str:
    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    for _ in range(32):
        candidate = SCRATCH_ROOT / f"session-{secrets.token_hex(8)}"
        try:
            candidate.mkdir(mode=0o700)
            return str(candidate)
        except FileExistsError:
            continue
    raise RuntimeError("Не удалось создать уникальный scratch-каталог")


def cleanup_scratch_directory(value: object) -> None:
    candidate = resolve_directory(value)
    if candidate is None or candidate == SCRATCH_ROOT or SCRATCH_ROOT not in candidate.parents:
        return
    try:
        shutil.rmtree(candidate)
    except FileNotFoundError:
        pass
    except OSError as exc:
        sys.stderr.write(f"Не удалось удалить scratch-каталог {candidate}: {exc}\n")


def backend_json(method: str, target: str) -> object | None:
    headers = {
        "Authorization": BACKEND_AUTH,
        "Host": BACKEND.hostname or "localhost",
        "Accept": "application/json",
    }
    connection = http.client.HTTPConnection(BACKEND.hostname, BACKEND.port or 80, timeout=15)
    try:
        connection.request(method, target, headers=headers)
        response = connection.getresponse()
        body = response.read()
        if response.status < 200 or response.status >= 300:
            return None
        return json.loads(body.decode("utf-8")) if body else None
    except (OSError, http.client.HTTPException, UnicodeDecodeError, json.JSONDecodeError):
        return None
    finally:
        connection.close()


def session_directory(path: str) -> str | None:
    if not SESSION_DELETE_RE.fullmatch(path):
        return None
    payload = backend_json("GET", path)
    if not isinstance(payload, dict):
        return None
    session = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    location = session.get("location") if isinstance(session, dict) else None
    directory = location.get("directory") if isinstance(location, dict) else None
    return directory if isinstance(directory, str) else None


def mark_quick_session(session: object) -> object:
    if not isinstance(session, dict):
        return session
    location = session.get("location")
    directory = location.get("directory") if isinstance(location, dict) else None
    if is_scratch_path(directory):
        session = dict(session)
        session["projectID"] = SCRATCH_PROJECT_ID
    return session


def transform_json_response(method: str, path: str, body: bytes) -> bytes:
    if method != "GET" or not body:
        return body
    if path not in ("/api/session", "/api/project"):
        return body
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return body

    if path == "/api/session":
        if isinstance(payload, dict) and isinstance(payload.get("data"), list):
            payload = dict(payload)
            payload["data"] = [
                mark_quick_session(session)
                for session in payload["data"]
                if not (isinstance(session, dict) and session.get("parentID"))
            ]
        elif isinstance(payload, list):
            payload = [
                mark_quick_session(session)
                for session in payload
                if not (isinstance(session, dict) and session.get("parentID"))
            ]
    elif path == "/api/project":
        quick_project = {
            "id": SCRATCH_PROJECT_ID,
            "name": SCRATCH_PROJECT_NAME,
            "canonical": SCRATCH_DIRECTORY,
        }
        if isinstance(payload, list):
            payload = [project for project in payload if not (isinstance(project, dict) and project.get("id") == SCRATCH_PROJECT_ID)]
            payload.append(quick_project)
        elif isinstance(payload, dict) and isinstance(payload.get("data"), list):
            payload = dict(payload)
            projects = [project for project in payload["data"] if not (isinstance(project, dict) and project.get("id") == SCRATCH_PROJECT_ID)]
            projects.append(quick_project)
            payload["data"] = projects

    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write(f"{fmt % args}\n")

    def authenticated(self) -> bool:
        if ALLOW_LOCAL and is_loopback(self.client_address[0]):
            return True
        supplied = self.headers.get("Authorization", "")
        if not secrets.compare_digest(supplied, CLIENT_AUTH):
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="OpenCode web"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return False
        return True

    def do_OPTIONS(self) -> None:
        if not self.authenticated():
            return
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        if not self.authenticated():
            return
        path = urlsplit(self.path).path
        if path.startswith("/api/"):
            self.proxy()
            return
        if path == "/client-config.json":
            self.json_response({"scratchDirectory": SCRATCH_DIRECTORY})
            return
        self.static_file(path)

    def do_HEAD(self) -> None:
        if not self.authenticated():
            return
        path = urlsplit(self.path).path
        if path.startswith("/api/"):
            self.proxy()
            return
        self.static_file(path, head_only=True)

    def do_POST(self) -> None:
        if self.authenticated():
            self.proxy()

    def do_PUT(self) -> None:
        if self.authenticated():
            self.proxy()

    def do_PATCH(self) -> None:
        if self.authenticated():
            self.proxy()

    def do_DELETE(self) -> None:
        if self.authenticated():
            self.proxy()

    def static_file(self, path: str, head_only: bool = False) -> None:
        if path in ("", "/"):
            path = "/index.html"
        candidate = (ROOT / path.lstrip("/")).resolve()
        if ROOT not in candidate.parents and candidate != ROOT:
            self.send_error(403)
            return
        if not candidate.is_file():
            self.send_error(404)
            return
        try:
            body = candidate.read_bytes()
        except OSError as exc:
            self.send_error(500, str(exc))
            return
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def json_response(self, value: object) -> None:
        body = json.dumps(value).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def proxy(self) -> None:
        parsed = urlsplit(self.path)
        if not parsed.path.startswith("/api/"):
            self.send_error(404)
            return
        if self.headers.get("Upgrade"):
            self.send_error(501, "WebSocket proxy is not part of this MVP")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(400, "Invalid Content-Length")
            return
        if length < 0:
            self.send_error(400, "Invalid Content-Length")
            return
        body = self.rfile.read(length) if length else None
        allocated_scratch: str | None = None
        cleanup_after_delete: str | None = None

        if self.command == "POST" and parsed.path == "/api/session" and body:
            try:
                payload = json.loads(body.decode("utf-8"))
                location = payload.get("location") if isinstance(payload, dict) else None
                requested_directory = location.get("directory") if isinstance(location, dict) else None
                if resolve_directory(requested_directory) == SCRATCH_ROOT:
                    allocated_scratch = allocate_scratch_directory()
                    payload = dict(payload)
                    payload["location"] = dict(location)
                    payload["location"]["directory"] = allocated_scratch
                    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            except (UnicodeDecodeError, json.JSONDecodeError, RuntimeError) as exc:
                if allocated_scratch:
                    cleanup_scratch_directory(allocated_scratch)
                self.send_error(500, str(exc))
                return

        if self.command == "DELETE" and SESSION_DELETE_RE.fullmatch(parsed.path):
            cleanup_after_delete = session_directory(parsed.path)

        target = parsed.path + (f"?{parsed.query}" if parsed.query else "")
        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in HOP_BY_HOP and key.lower() not in ("authorization", "content-length")
        }
        headers["Authorization"] = BACKEND_AUTH
        headers["Host"] = BACKEND.hostname
        if body is not None:
            headers["Content-Length"] = str(len(body))

        connection = http.client.HTTPConnection(BACKEND.hostname, BACKEND.port or 80, timeout=300)
        response_started = False
        try:
            connection.request(self.command, target, body=body, headers=headers)
            response = connection.getresponse()
            content_type = response.getheader("Content-Type", "")
            streaming = content_type.startswith("text/event-stream")
            if streaming:
                self.send_response(response.status, response.reason)
                for key, value in response.getheaders():
                    if key.lower() not in HOP_BY_HOP and key.lower() != "content-length":
                        self.send_header(key, value)
                self.send_header("Connection", "close")
                self.end_headers()
                response_started = True
                while True:
                    line = response.readline()
                    if not line:
                        break
                    self.wfile.write(line)
                    self.wfile.flush()
                return

            response_body = response.read()
            success = 200 <= response.status < 300
            if allocated_scratch and not success:
                cleanup_scratch_directory(allocated_scratch)
                allocated_scratch = None
            if cleanup_after_delete and success:
                cleanup_scratch_directory(cleanup_after_delete)
            if content_type.startswith("application/json"):
                response_body = transform_json_response(self.command, parsed.path, response_body)

            self.send_response(response.status, response.reason)
            for key, value in response.getheaders():
                if key.lower() not in HOP_BY_HOP and key.lower() != "content-length":
                    self.send_header(key, value)
            self.send_header("Content-Length", str(len(response_body)))
            self.end_headers()
            response_started = True
            self.wfile.write(response_body)
        except (OSError, http.client.HTTPException) as exc:
            if allocated_scratch:
                cleanup_scratch_directory(allocated_scratch)
            if not response_started:
                self.send_error(502, f"V2 backend unavailable: {exc}")
        finally:
            connection.close()


def main() -> None:
    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    server = ThreadingHTTPServer((WEB_HOST, WEB_PORT), Handler)
    print(f"OpenCode web client started on configured port {WEB_PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
