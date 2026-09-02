#!/usr/bin/env python3
"""Tiny same-origin proxy and static server for the OpenCode V2 web client."""

from __future__ import annotations

import base64
import hashlib
import hmac
import http.client
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import shutil
import sys
import threading
import time
from urllib.parse import parse_qs, quote, urlsplit
from urllib.parse import SplitResult


ROOT = Path(__file__).resolve().parent
DEFAULT_SERVICE_FILE = Path.home() / ".local/state/opencode/service.json"
DEFAULT_LEGACY_AUTH_FILE = Path.home() / ".config/opencode/mobile-server.env"
SCRATCH_PROJECT_ID = "__custom_opencode_quick__"
SCRATCH_PROJECT_NAME = "Быстрые"
SESSION_DELETE_RE = re.compile(r"^/api/session/[^/]+$")
SESSION_ANY_RE = re.compile(r"^/api/session/([^/]+)")
AUTH_COOKIE_NAME = "opencode_session"
PUBLIC_PATHS = {"/login.html", "/login.css", "/login.js"}


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
ALLOW_BASIC_AUTH = setting("OPENCODE_AUTH_ALLOW_BASIC", "0").lower() in ("1", "true", "yes")
AUTH_SESSION_SECONDS = max(300, int(setting("OPENCODE_AUTH_SESSION_SECONDS", "86400")))
AUTH_REMEMBER_SECONDS = max(AUTH_SESSION_SECONDS, int(setting("OPENCODE_AUTH_REMEMBER_SECONDS", "2592000")))
AUTH_COOKIE_SECURE = setting("OPENCODE_AUTH_COOKIE_SECURE", "auto").strip().lower()
SCRATCH_ROOT = Path(setting("OPENCODE_SCRATCH_DIRECTORY", str(Path.home() / "opencode-scratch"))).expanduser().resolve()
SCRATCH_DIRECTORY = str(SCRATCH_ROOT)


def basic_value(user: str, password: str) -> str:
    value = f"{user}:{password}".encode("utf-8")
    return "Basic " + base64.b64encode(value).decode("ascii")


def b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


CLIENT_AUTH = basic_value(CLIENT_USER, CLIENT_PASSWORD)
BACKEND_AUTH = basic_value(BACKEND_USER, BACKEND_PASSWORD)

# The shared V2 backend service restarts on a new port with a new password and
# rewrites service.json each time. A web client that pins the backend at
# startup would answer 502 for every /api/* call until manually restarted, so
# service discovery is re-read on a short TTL and force-refreshed on failure.
_BACKEND_EXPLICIT = bool(setting("OPENCODE_BACKEND_URL") and setting("OPENCODE_BACKEND_PASSWORD"))
_BACKEND_CACHE_TTL = 5.0
_backend_state = {"host": BACKEND.hostname, "port": BACKEND.port or 80, "auth": BACKEND_AUTH, "at": 0.0}
_backend_lock = threading.Lock()


def _discover_backend() -> tuple[str, int, str] | None:
    try:
        service = json.loads(SERVICE_FILE.read_text(encoding="utf-8"))
        url = str(service["url"]).rstrip("/")
        password = str(service["password"])
    except (OSError, KeyError, TypeError, ValueError):
        return None
    parsed = urlsplit(url)
    if parsed.scheme != "http" or not parsed.hostname or parsed.path not in ("", "/"):
        return None
    return parsed.hostname, parsed.port or 80, basic_value(BACKEND_USER, password)


def current_backend(force_refresh: bool = False) -> tuple[str, int, str]:
    """Live (host, port, auth) of the V2 backend."""
    if _BACKEND_EXPLICIT:
        return BACKEND.hostname, BACKEND.port or 80, BACKEND_AUTH
    now = time.monotonic()
    with _backend_lock:
        if not force_refresh and now - _backend_state["at"] < _BACKEND_CACHE_TTL:
            return _backend_state["host"], _backend_state["port"], _backend_state["auth"]
        discovered = _discover_backend()
        if discovered is not None:
            _backend_state["host"], _backend_state["port"], _backend_state["auth"] = discovered
        _backend_state["at"] = now
        return _backend_state["host"], _backend_state["port"], _backend_state["auth"]


def backend_connection(host: str, port: int, read_timeout: float,
                       connect_timeout: float = 5.0) -> http.client.HTTPConnection:
    """Backend HTTP connection with separate connect and read timeouts.

    Closed ports can be blackholed instead of refused (WSL/firewall quirks),
    so a single long timeout would hang every request for minutes right after
    the backend restarted. Connect failures surface quickly and trigger the
    service-discovery refresh/retry path instead.
    """
    connection = http.client.HTTPConnection(host, port, timeout=connect_timeout)
    connection.connect()
    if connection.sock is not None:
        connection.sock.settimeout(read_timeout)
    return connection


def _attempt_backend_request(command: str, target: str, host: str, port: int, auth: str,
                             headers: dict[str, str], body: bytes | None,
                             read_timeout: float = 300.0):
    """(connection, response), re-resolving the backend once on connect failure."""
    headers["Authorization"] = auth
    headers["Host"] = host
    try:
        connection = backend_connection(host, port, read_timeout=read_timeout)
        connection.request(command, target, body=body, headers=headers)
        return connection, connection.getresponse()
    except (OSError, http.client.HTTPException):
        # The backend may have just restarted on a new port/password.
        refreshed = current_backend(force_refresh=True)
        if refreshed == (host, port, auth):
            raise
        host, port, auth = refreshed
        headers["Authorization"] = auth
        headers["Host"] = host
        connection = backend_connection(host, port, read_timeout=read_timeout)
        connection.request(command, target, body=body, headers=headers)
        return connection, connection.getresponse()


AUTH_KEY = hashlib.sha256(
    f"custom-opencode-auth-v1\0{CLIENT_USER}\0{CLIENT_PASSWORD}".encode("utf-8")
).digest()
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


def issue_session_token(ttl_seconds: int) -> str:
    payload = json.dumps(
        {"u": CLIENT_USER, "exp": int(time.time()) + ttl_seconds, "v": 1},
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    signature = hmac.new(AUTH_KEY, payload, hashlib.sha256).digest()
    return f"{b64url_encode(payload)}.{b64url_encode(signature)}"


def valid_session_token(token: str) -> bool:
    try:
        payload_part, signature_part = token.split(".", 1)
        payload = b64url_decode(payload_part)
        supplied_signature = b64url_decode(signature_part)
        expected_signature = hmac.new(AUTH_KEY, payload, hashlib.sha256).digest()
        if not hmac.compare_digest(supplied_signature, expected_signature):
            return False
        data = json.loads(payload.decode("utf-8"))
        if data.get("v") != 1 or data.get("u") != CLIENT_USER:
            return False
        return int(data.get("exp", 0)) >= int(time.time())
    except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
        return False


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
    host, port, auth = current_backend()
    headers = {
        "Authorization": auth,
        "Host": host or "localhost",
        "Accept": "application/json",
    }
    connection = None
    try:
        try:
            connection = backend_connection(host, port, read_timeout=15)
            connection.request(method, target, headers=headers)
            response = connection.getresponse()
        except (OSError, http.client.HTTPException):
            if connection is not None:
                connection.close()
            refreshed = current_backend(force_refresh=True)
            if refreshed == (host, port, auth):
                return None
            host, port, auth = refreshed
            headers["Authorization"] = auth
            headers["Host"] = host or "localhost"
            connection = backend_connection(host, port, read_timeout=15)
            connection.request(method, target, headers=headers)
            response = connection.getresponse()
        body = response.read()
        if response.status < 200 or response.status >= 300:
            return None
        return json.loads(body.decode("utf-8")) if body else None
    except (OSError, http.client.HTTPException, UnicodeDecodeError, json.JSONDecodeError):
        return None
    finally:
        if connection is not None:
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


_SESSION_DIR_CACHE: dict[str, str] = {}
_SESSION_DIR_LOCK = threading.Lock()


def cached_session_directory(session_id: str) -> str | None:
    """Return the backend session directory, caching per session id."""
    with _SESSION_DIR_LOCK:
        cached = _SESSION_DIR_CACHE.get(session_id)
    if cached is not None:
        return cached
    payload = backend_json("GET", f"/api/session/{quote(session_id)}")
    if not isinstance(payload, dict):
        return None
    session = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    location = session.get("location") if isinstance(session, dict) else None
    directory = location.get("directory") if isinstance(location, dict) else None
    if not isinstance(directory, str):
        return None
    with _SESSION_DIR_LOCK:
        _SESSION_DIR_CACHE[session_id] = directory
    return directory


def forget_session_directory(session_id: str) -> None:
    with _SESSION_DIR_LOCK:
        _SESSION_DIR_CACHE.pop(session_id, None)


def heal_missing_scratch_directory(value: object) -> None:
    """Recreate a scratch session directory that was removed out-of-band.

    The backend resolves the session workspace before serving most session
    endpoints; a missing directory makes those calls fail until the session
    is deleted. Recreating the empty directory restores access.
    """
    candidate = resolve_directory(value)
    if candidate is None or candidate == SCRATCH_ROOT or SCRATCH_ROOT not in candidate.parents:
        return
    if candidate.exists():
        return
    try:
        candidate.mkdir(parents=True, mode=0o700)
    except OSError as exc:
        sys.stderr.write(f"Не удалось восстановить scratch-каталог {candidate}: {exc}\n")


def heal_request_scratch(command: str, parsed: SplitResult) -> None:
    """Best-effort healing for any request touching a session or directory."""
    if command == "DELETE":
        return
    try:
        if parsed.query:
            query = parse_qs(parsed.query)
            for key in ("directory", "sessionID"):
                for value in query.get(key, []):
                    if key == "directory":
                        heal_missing_scratch_directory(value)
                    else:
                        heal_missing_scratch_directory(cached_session_directory(value))
        match = SESSION_ANY_RE.match(parsed.path)
        if match:
            heal_missing_scratch_directory(cached_session_directory(match.group(1)))
    except Exception as exc:  # noqa: BLE001 - healing must never break proxying
        sys.stderr.write(f"heal_request_scratch проигнорирован: {exc}\n")


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
    if not body or path not in ("/api/session", "/api/project"):
        return body
    if method not in ("GET", "POST"):
        return body
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return body

    if path == "/api/session" and method == "POST":
        if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
            payload = dict(payload)
            payload["data"] = mark_quick_session(payload["data"])
        elif isinstance(payload, dict):
            payload = mark_quick_session(payload)
    elif path == "/api/session":
        if isinstance(payload, dict) and isinstance(payload.get("data"), list):
            payload = dict(payload)
            payload["data"] = [mark_quick_session(session) for session in payload["data"]]
        elif isinstance(payload, list):
            payload = [mark_quick_session(session) for session in payload]
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

    def cookie_token(self) -> str:
        header = self.headers.get("Cookie", "")
        if not header:
            return ""
        try:
            cookie = SimpleCookie()
            cookie.load(header)
            morsel = cookie.get(AUTH_COOKIE_NAME)
            return morsel.value if morsel else ""
        except Exception:
            return ""

    def local_bypass(self) -> bool:
        return ALLOW_LOCAL and is_loopback(self.client_address[0])

    def authenticated(self) -> bool:
        if self.local_bypass():
            return True
        if valid_session_token(self.cookie_token()):
            return True
        if ALLOW_BASIC_AUTH:
            supplied = self.headers.get("Authorization", "")
            if supplied and secrets.compare_digest(supplied, CLIENT_AUTH):
                return True
        return False

    def request_is_secure(self) -> bool:
        if AUTH_COOKIE_SECURE in ("1", "true", "yes"):
            return True
        if AUTH_COOKIE_SECURE in ("0", "false", "no"):
            return False
        forwarded_proto = self.headers.get("X-Forwarded-Proto", "").split(",", 1)[0].strip().lower()
        if forwarded_proto == "https":
            return True
        forwarded = self.headers.get("Forwarded", "").lower()
        return "proto=https" in forwarded

    def session_cookie(self, token: str, *, remember: bool) -> str:
        parts = [
            f"{AUTH_COOKIE_NAME}={token}",
            "Path=/",
            "HttpOnly",
            "SameSite=Strict",
        ]
        if remember:
            parts.append(f"Max-Age={AUTH_REMEMBER_SECONDS}")
        if self.request_is_secure():
            parts.append("Secure")
        return "; ".join(parts)

    def clear_session_cookie(self) -> str:
        parts = [
            f"{AUTH_COOKIE_NAME}=",
            "Path=/",
            "Max-Age=0",
            "HttpOnly",
            "SameSite=Strict",
        ]
        if self.request_is_secure():
            parts.append("Secure")
        return "; ".join(parts)

    def unauthorized(self, *, redirect: bool = False) -> None:
        if redirect:
            next_value = quote(self.path or "/", safe="")
            self.send_response(302)
            self.send_header("Location", f"/login.html?next={next_value}")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.json_response({"ok": False, "error": "Требуется авторизация"}, status=401)

    def read_json_body(self, *, limit: int = 8192) -> dict[str, object] | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length <= 0 or length > limit:
            return None
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return value if isinstance(value, dict) else None

    def login(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            self.json_response({"ok": False, "error": "Некорректный запрос"}, status=400)
            return
        username = str(payload.get("username", ""))
        password = str(payload.get("password", ""))
        remember = bool(payload.get("remember", False))
        user_ok = secrets.compare_digest(username, CLIENT_USER)
        password_ok = secrets.compare_digest(password, CLIENT_PASSWORD)
        if not (user_ok and password_ok):
            time.sleep(0.35)
            self.json_response({"ok": False, "error": "Неверный логин или пароль"}, status=401)
            return

        ttl = AUTH_REMEMBER_SECONDS if remember else AUTH_SESSION_SECONDS
        token = issue_session_token(ttl)
        self.send_response(204)
        self.send_header("Set-Cookie", self.session_cookie(token, remember=remember))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def logout(self) -> None:
        self.send_response(204)
        self.send_header("Set-Cookie", self.clear_session_cookie())
        # Clear-Site-Data валиден только на secure-оригинах: поверх http://
        # браузер его отклоняет и пишет предупреждение в консоль.
        if self.request_is_secure():
            self.send_header("Clear-Site-Data", '"cache"')
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_OPTIONS(self) -> None:
        path = urlsplit(self.path).path
        if path == "/auth/login":
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if not self.authenticated():
            self.unauthorized()
            return
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/auth/session":
            if not self.authenticated():
                self.unauthorized()
                return
            self.json_response({
                "ok": True,
                "user": CLIENT_USER,
                "localBypass": self.local_bypass(),
            })
            return
        if path in PUBLIC_PATHS:
            self.static_file(path)
            return
        if not self.authenticated():
            if path.startswith("/api/") or path.startswith("/client-"):
                self.unauthorized()
            else:
                self.unauthorized(redirect=True)
            return
        if path.startswith("/api/"):
            self.proxy()
            return
        if path == "/client-config.json":
            self.json_response({"scratchDirectory": SCRATCH_DIRECTORY})
            return
        self.static_file(path)

    def do_HEAD(self) -> None:
        path = urlsplit(self.path).path
        if path in PUBLIC_PATHS:
            self.static_file(path, head_only=True)
            return
        if not self.authenticated():
            self.unauthorized(redirect=not path.startswith("/api/"))
            return
        if path.startswith("/api/"):
            self.proxy()
            return
        self.static_file(path, head_only=True)

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if path == "/auth/login":
            self.login()
            return
        if path == "/auth/logout":
            self.logout()
            return
        if not self.authenticated():
            self.unauthorized()
            return
        self.proxy()

    def do_PUT(self) -> None:
        if not self.authenticated():
            self.unauthorized()
            return
        self.proxy()

    def do_PATCH(self) -> None:
        if not self.authenticated():
            self.unauthorized()
            return
        self.proxy()

    def do_DELETE(self) -> None:
        if not self.authenticated():
            self.unauthorized()
            return
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
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def json_response(self, value: object, *, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if status >= 400:
            # Error handlers may reject a POST before consuming its body. Close
            # the HTTP/1.1 connection so those bytes cannot be parsed as a new request.
            self.close_connection = True
            self.send_header("Connection", "close")
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
        else:
            heal_request_scratch(self.command, parsed)

        target = parsed.path + (f"?{parsed.query}" if parsed.query else "")
        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in HOP_BY_HOP and key.lower() not in ("authorization", "content-length", "cookie")
        }
        host, port, auth = current_backend()
        headers["Authorization"] = auth
        headers["Host"] = host
        if body is not None:
            headers["Content-Length"] = str(len(body))

        connection = None
        response_started = False
        try:
            connection, response = _attempt_backend_request(
                self.command, target, host, port, auth, headers, body)
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
                    try:
                        self.wfile.write(line)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        self.close_connection = True
                        break
                return

            response_body = response.read()
            success = 200 <= response.status < 300
            if allocated_scratch:
                if success:
                    # The backend now owns this workspace through the persisted session.
                    allocated_scratch = None
                else:
                    cleanup_scratch_directory(allocated_scratch)
                    allocated_scratch = None
            if cleanup_after_delete and success:
                cleanup_scratch_directory(cleanup_after_delete)
                delete_match = SESSION_ANY_RE.match(parsed.path)
                if delete_match:
                    forget_session_directory(delete_match.group(1))
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
            if connection is not None:
                connection.close()


def main() -> None:
    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    server = ThreadingHTTPServer((WEB_HOST, WEB_PORT), Handler)
    server.daemon_threads = True
    print(f"OpenCode web client started on configured port {WEB_PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
