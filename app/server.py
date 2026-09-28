#!/usr/bin/env python3
"""Tiny same-origin proxy and static server for the OpenCode V2 web client."""

from __future__ import annotations

import base64
from collections.abc import MutableMapping
from dataclasses import dataclass
import functools
import gzip
import hashlib
import hmac
import http.client
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import sys
import threading
import time
from urllib.parse import parse_qs, quote, unquote, urlsplit
from urllib.parse import SplitResult

import server_users


# Server-side Git (status/ls-files/diff/log/worktree in the runtime, repo and
# workflow helpers) runs unsandboxed, with this process' secrets, inside
# agent-writable repositories whose .git/config may name programs. Every child
# git inherits command-scope overrides, which outrank repository config:
# - core.fsmonitor runs a hook on status/diff/ls-files;
# - core.hooksPath=/dev/null disables hooks such as post-checkout on
#   `git worktree add`;
# - log.showSignature=false stops `git log` from running gpg.program.
# diff.external is deliberately absent: an empty value makes every porcelain
# `git diff` fail ("external diff died") instead of disabling it, so diff call
# sites must pass --no-ext-diff/--no-textconv. filter.<driver>.clean/smudge
# (selected through .gitattributes) cannot be disabled globally at all.
GIT_HARDENING = (
    ("core.fsmonitor", "false"),
    ("core.hooksPath", "/dev/null"),
    ("log.showSignature", "false"),
)


def harden_git_environment(environ: MutableMapping[str, str] | None = None) -> dict[str, str | None]:
    """Append the GIT_CONFIG_* overrides, keeping pre-existing entries.

    Idempotent. Returns the previous value (None: unset) of every variable it
    changed, so a child that must not inherit the hardening can undo it.
    """
    environ = os.environ if environ is None else environ
    previous: dict[str, str | None] = {}

    def assign(name: str, value: str) -> None:
        if environ.get(name) == value:
            return
        previous.setdefault(name, environ.get(name))
        environ[name] = value

    try:
        count = int(environ.get("GIT_CONFIG_COUNT") or "0")
    except ValueError:
        count = -1
    if not 0 <= count <= 1000 or any(
        f"GIT_CONFIG_KEY_{index}" not in environ or f"GIT_CONFIG_VALUE_{index}" not in environ
        for index in range(count)
    ):
        # git refuses to run at all with a malformed list; start a new one.
        count = 0
    effective = {
        environ[f"GIT_CONFIG_KEY_{index}"].strip().lower(): environ[f"GIT_CONFIG_VALUE_{index}"]
        for index in range(count)
    }
    for key, value in GIT_HARDENING:
        if effective.get(key.lower()) == value:
            continue
        assign(f"GIT_CONFIG_KEY_{count}", key)
        assign(f"GIT_CONFIG_VALUE_{count}", value)
        effective[key.lower()] = value
        count += 1
    assign("GIT_CONFIG_COUNT", str(count))
    assign("GIT_TERMINAL_PROMPT", "0")
    return previous


GIT_HARDENING_UNDO = harden_git_environment()


ROOT = Path(__file__).resolve().parent
CUSTOM_ENV_FILE = ROOT.parent / ".env"
DEFAULT_SERVICE_FILE = Path.home() / ".local/state/opencode/service.json"
DEFAULT_LEGACY_AUTH_FILE = Path.home() / ".config/opencode/mobile-server.env"
SCRATCH_PROJECT_ID = "__custom_opencode_quick__"
SCRATCH_PROJECT_NAME = "Быстрые"
SESSION_DELETE_RE = re.compile(r"^/api/session/[^/]+$")
SESSION_ANY_RE = re.compile(r"^/api/session/([^/]+)")
AUTH_COOKIE_NAME = "opencode_session"
PUBLIC_PATHS = {
    "/login.html",
    "/login.css",
    "/login.js",
    "/favicon.ico",
    "/favicon.svg",
    "/apple-touch-icon.png",
    "/icon-192.png",
    "/icon-512.png",
}


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


def write_env_value(path: Path, name: str, value: str) -> None:
    """Update one private env value without echoing or logging the secret."""
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    replacement = f"{name}={value}"
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.startswith(f"{name}="):
            lines[index] = replacement
            break
    else:
        if lines and lines[-1] != "":
            lines.append("")
        lines.append(replacement)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def configure_qwen_token_plan(api_key: str, model: str) -> None:
    """Persist the Token Plan key and ask OpenCode's service manager to reload it."""
    write_env_value(CUSTOM_ENV_FILE, "TOKEN_PLAN_API_KEY", api_key)
    write_env_value(CUSTOM_ENV_FILE, "TOKEN_PLAN_PROBE_MODEL", model)
    env = os.environ.copy()
    env.pop("OPENCODE_CONFIG_DIR", None)
    # The backend service (and agent shells it spawns) must not silently
    # inherit this web process' Git hardening, e.g. disabled commit hooks.
    for name, value in GIT_HARDENING_UNDO.items():
        if value is None:
            env.pop(name, None)
        else:
            env[name] = value
    binary = shutil.which("opencode2")
    if not binary:
        raise RuntimeError("opencode2 не найден в PATH")
    try:
        subprocess.run(
            [binary, "service", "set", "env", "TOKEN_PLAN_API_KEY", api_key],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=45,
            env=env,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("перезапуск backend ещё не завершён") from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError("OpenCode не принял обновление ключа") from exc


_LOCAL_ENV = {
    **read_env_file(ROOT.parent / ".env"),
    **read_env_file(ROOT / ".env"),
}
_USER_CONFIG = os.environ.get("CUSTOM_OPENCODE_USER_CONFIG") or _LOCAL_ENV.get("CUSTOM_OPENCODE_USER_CONFIG")
# Private user-config settings first (scripts/user-config.sh); the local .env wins.
BASE_ENV = {
    **(read_env_file(ROOT.parent / Path(_USER_CONFIG).expanduser() / "settings.env") if _USER_CONFIG else {}),
    **_LOCAL_ENV,
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
if not CLIENT_PASSWORD or not CLIENT_PASSWORD.strip():
    raise SystemExit("Не задан OPENCODE_SERVER_PASSWORD в .env")
if CLIENT_PASSWORD.strip() == "CHANGE_ME":
    raise SystemExit("OPENCODE_SERVER_PASSWORD в .env всё ещё CHANGE_ME: задайте настоящий пароль")
# server_users reads the env user from os.environ at call time. Keep it on the
# credential validated above even when that came from an env file, otherwise
# it would see an empty admin password.
for _name, _value in (("OPENCODE_SERVER_USERNAME", CLIENT_USER), ("OPENCODE_SERVER_PASSWORD", CLIENT_PASSWORD)):
    if not os.environ.get(_name):
        os.environ[_name] = _value
del _name, _value

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
FORWARDING_HEADER_NAMES = ("Forwarded", "X-Forwarded-For", "X-Real-IP", "X-Forwarded-Proto")
STATE_CHANGING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
# Endpoint namespaces. Another site may navigate to an application page, but
# it never reaches these (fetch-metadata resource isolation).
ENDPOINT_PREFIXES = ("/api/", "/client-", "/auth/", "/internal/")


def parse_origin(value: str) -> tuple[str, str, int] | None:
    """(scheme, host, port) of a browser Origin header; None when opaque."""
    try:
        parsed = urlsplit(value.strip())
        port = parsed.port
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    if parsed.path or parsed.query or parsed.fragment or parsed.username is not None:
        return None
    return parsed.scheme, parsed.hostname.rstrip(".").lower(), port or (443 if parsed.scheme == "https" else 80)


def parse_authority(value: str) -> tuple[str, int | None] | None:
    """(host, port) of a Host/X-Forwarded-Host value."""
    value = value.strip()
    if not value or any(char in value for char in "/?#@ \t\\"):
        return None
    try:
        parsed = urlsplit(f"//{value}")
        port = parsed.port
    except ValueError:
        return None
    if not parsed.hostname:
        return None
    return parsed.hostname.rstrip(".").lower(), port


def origin_matches_authority(origin: tuple[str, str, int], authority: tuple[str, int | None]) -> bool:
    scheme, host, port = origin
    authority_host, authority_port = authority
    if host != authority_host:
        return False
    if authority_port is None:
        return port == (443 if scheme == "https" else 80)
    return port == authority_port


# Reverse proxies that rewrite Host without X-Forwarded-Host (nginx default)
# must list their public origin, e.g. https://phone.example.ts.net.
ALLOWED_ORIGINS = frozenset(
    origin
    for item in re.split(r"[\s,]+", setting("OPENCODE_WEB_ALLOWED_ORIGINS", "") or "")
    if item and (origin := parse_origin(item.rstrip("/")))
)


# Static client files come from the slow /mnt/c 9P filesystem: serve only
# known asset types from memory, revalidating the file stamp at most every
# STATIC_REVALIDATE_SECONDS. Cache-Control stays no-cache with a strong ETag,
# so browsers revalidate each use and deployments apply immediately.
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
}
STATIC_COMPRESSIBLE = frozenset({".html", ".js", ".css", ".svg", ".webmanifest"})
STATIC_SEGMENT_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*")
STATIC_REVALIDATE_SECONDS = 2.0
STATIC_CACHE_LIMIT = 512
_INLINE_SCRIPT_RE = re.compile(rb"<script(?![^>]*\bsrc\s*=)[^>]*>(.*?)</script\s*>", re.S | re.I)


def content_security_policy(html: bytes) -> str:
    """CSP for an app page; its own inline scripts are allowed by hash only."""
    hashes = []
    for match in _INLINE_SCRIPT_RE.finditer(html):
        # Browsers hash the parsed text, after CRLF/CR normalization.
        text = match.group(1).replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        if text.strip():
            digest = base64.b64encode(hashlib.sha256(text).digest()).decode("ascii")
            hashes.append(f"'sha256-{digest}'")
    return "; ".join((
        "default-src 'self'",
        # The app never evaluates strings, but browser automation used by the
        # e2e suites (Playwright wait_for_function) does. Injected inline
        # scripts, event-handler attributes and javascript: URLs stay blocked.
        "script-src " + " ".join(["'self'", *hashes, "'unsafe-eval'"]),
        # Inline style attributes are used by rendered progress bars/swatches.
        "style-src 'self' 'unsafe-inline'",
        "img-src * data: blob:",
        "font-src 'self' data:",
        "media-src 'self' data: blob:",
        "connect-src 'self'",
        "worker-src 'self'",
        "manifest-src 'self'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ))


@dataclass
class StaticAsset:
    path: Path
    stamp: tuple[int, int]
    checked: float
    body: bytes
    gzip_body: bytes | None
    etag: str
    content_type: str
    csp: str | None


_static_cache: dict[str, StaticAsset] = {}
_static_lock = threading.Lock()


def static_relative_path(path: str) -> str | None:
    """Canonical app-relative asset name, or None when it must not be served.

    Dotfiles, __pycache__, Python sources and any non-asset type are never
    served, and every name has exactly one spelling (bounded cache keys).
    """
    if path in ("", "/"):
        path = "/index.html"
    if not path.startswith("/"):
        return None
    segments = path[1:].split("/")
    if any(segment == "__pycache__" or not STATIC_SEGMENT_RE.fullmatch(segment) for segment in segments):
        return None
    if os.path.splitext(segments[-1])[1] not in STATIC_TYPES:
        return None
    return "/".join(segments)


def _load_static_asset(relative: str) -> StaticAsset | None:
    segments = relative.split("/")
    directory = ROOT
    try:
        for segment in segments:
            # Exact names only: a case-insensitive filesystem must not map
            # unboundedly many spellings onto one cached file.
            if segment not in os.listdir(directory):
                return None
            directory = directory / segment
        resolved = directory.resolve(strict=True)
        inner = resolved.relative_to(ROOT).parts
    except (OSError, RuntimeError, ValueError):
        return None
    if not inner or any(part.startswith(".") or part == "__pycache__" for part in inner):
        return None
    suffix = resolved.suffix
    if suffix not in STATIC_TYPES:
        return None
    try:
        with open(resolved, "rb") as handle:
            details = os.fstat(handle.fileno())
            if not stat.S_ISREG(details.st_mode):
                return None
            body = handle.read()
    except OSError:
        return None
    digest = hashlib.sha256(body).hexdigest()[:32]
    compressed = None
    if suffix in STATIC_COMPRESSIBLE and len(body) >= 256:
        candidate = gzip.compress(body, compresslevel=6, mtime=0)
        if len(candidate) < len(body):
            compressed = candidate
    return StaticAsset(
        path=resolved,
        stamp=(details.st_mtime_ns, details.st_size),
        checked=time.monotonic(),
        body=body,
        gzip_body=compressed,
        etag=f'"{digest}"',
        content_type=STATIC_TYPES[suffix],
        csp=content_security_policy(body) if suffix == ".html" else None,
    )


def static_asset(relative: str) -> StaticAsset | None:
    now = time.monotonic()
    with _static_lock:
        asset = _static_cache.get(relative)
    if asset is not None:
        if now - asset.checked < STATIC_REVALIDATE_SECONDS:
            return asset
        try:
            details = os.stat(asset.path)
            if stat.S_ISREG(details.st_mode) and (details.st_mtime_ns, details.st_size) == asset.stamp:
                asset.checked = now
                return asset
        except OSError:
            pass
    asset = _load_static_asset(relative)
    with _static_lock:
        if asset is None:
            _static_cache.pop(relative, None)
        else:
            if relative not in _static_cache and len(_static_cache) >= STATIC_CACHE_LIMIT:
                _static_cache.clear()
            _static_cache[relative] = asset
    return asset


def accepts_gzip(header: str) -> bool:
    quality: dict[str, float] = {}
    for item in header.split(","):
        name, _, parameters = item.partition(";")
        name = name.strip().lower()
        if not name:
            continue
        value = 1.0
        for parameter in parameters.split(";"):
            key, _, raw = parameter.partition("=")
            if key.strip().lower() == "q":
                try:
                    value = float(raw.strip())
                except ValueError:
                    value = 0.0
        quality[name] = value
    for name in ("gzip", "x-gzip", "*"):
        if name in quality:
            return quality[name] > 0
    return False


def etag_matches(header: str | None, etag: str) -> bool:
    """Weak comparison, as required for If-None-Match."""
    if not header:
        return False
    if header.strip() == "*":
        return True
    wanted = etag[2:] if etag.startswith("W/") else etag
    for candidate in header.split(","):
        candidate = candidate.strip()
        if candidate.startswith("W/"):
            candidate = candidate[2:]
        if candidate == wanted:
            return True
    return False


class BodyCountingReader:
    """rfile proxy counting request-body bytes consumed by a handler.

    Keep-alive is only safe when the whole body was read; leftover bytes would
    otherwise be parsed as the next request on the connection.
    """

    def __init__(self, raw: object) -> None:
        self._raw = raw
        self.body_consumed = 0

    def read(self, size: int = -1) -> bytes:
        data = self._raw.read(size)
        self.body_consumed += len(data)
        return data

    def read1(self, size: int = -1) -> bytes:
        data = self._raw.read1(size)
        self.body_consumed += len(data)
        return data

    def readline(self, size: int = -1) -> bytes:
        data = self._raw.readline(size)
        self.body_consumed += len(data)
        return data

    def readinto(self, buffer: bytearray) -> int:
        count = self._raw.readinto(buffer) or 0
        self.body_consumed += count
        return count

    def __getattr__(self, name: str) -> object:
        return getattr(self._raw, name)


class ThreadingWebServer(ThreadingHTTPServer):
    """Threaded listener with a deeper accept backlog than socketserver's 5."""

    daemon_threads = True
    request_queue_size = 128


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
# Client bodies are fully buffered in RAM before being proxied to the backend,
# so a hostile Content-Length must be rejected before any read happens.
MAX_PROXY_BODY_BYTES = 64 * 1024 * 1024
# Forwarding headers describe the client<->proxy hop. Passing client-supplied
# values to the backend would let a remote peer spoof its IP/protocol there.
FORWARDED_HEADERS = {
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
}


@functools.cache
def _auth_key_v2() -> bytes:
    """Lazy v2 key derivation using server_users.server_secret().

    No file side effects at import time.
    """
    secret = server_users.server_secret()
    return hashlib.sha256(f"custom-opencode-auth-v2\0{secret}".encode("utf-8")).digest()


def _env_password_fingerprint() -> str:
    """Fingerprint of current CLIENT_PASSWORD for env-user token invalidation."""
    return hashlib.sha256(f"custom-opencode-env-fp\0{CLIENT_PASSWORD}".encode()).hexdigest()


def issue_session_token(ttl_seconds: int, username: str | None = None) -> str:
    """Issue a v2 session token for the given username (defaults to CLIENT_USER)."""
    if username is None:
        username = CLIENT_USER
    payload_dict = {"u": username, "exp": int(time.time()) + ttl_seconds, "v": 2, "nonce": secrets.token_urlsafe(16)}
    if username == CLIENT_USER:
        payload_dict["pf"] = _env_password_fingerprint()
    payload = json.dumps(
        payload_dict,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    signature = hmac.new(_auth_key_v2(), payload, hashlib.sha256).digest()
    return f"{b64url_encode(payload)}.{b64url_encode(signature)}"


def valid_session_token(token: str) -> str | None:
    """Validate session token and return username (str) or None.

    v==1 tokens use legacy AUTH_KEY (must match CLIENT_USER).
    v==2 tokens use _auth_key_v2() and check user_exists.
    """
    try:
        payload_part, signature_part = token.split(".", 1)
        payload = b64url_decode(payload_part)
        supplied_signature = b64url_decode(signature_part)
        data = json.loads(payload.decode("utf-8"))
        version = data.get("v")
        username = data.get("u")

        if not isinstance(version, int) or isinstance(version, bool):
            return None

        if version == 1:
            # Legacy v1 token
            expected_signature = hmac.new(AUTH_KEY, payload, hashlib.sha256).digest()
            if not hmac.compare_digest(supplied_signature, expected_signature):
                return None
            if username != CLIENT_USER:
                return None
        elif version == 2:
            # v2 token
            expected_signature = hmac.new(_auth_key_v2(), payload, hashlib.sha256).digest()
            if not hmac.compare_digest(supplied_signature, expected_signature):
                return None
            if not isinstance(username, str) or not server_users.user_exists(username):
                return None
            if username == CLIENT_USER:
                pf = data.get("pf")
                if not isinstance(pf, str):
                    return None
                if not hmac.compare_digest(pf, _env_password_fingerprint()):
                    return None
        else:
            return None

        if int(data.get("exp", 0)) < int(time.time()):
            return None
        return username
    except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
        return None


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


# Consent, credential and destructive boundaries (state-changing requests
# only). They decide what the agent may do next (permission replies, budget
# approvals, permission rules, sandbox, worktree merge), change credentials or
# tool configuration (provider keys, MCP/config, slash-command config) or
# destroy work (git revert). The loopback convenience bypass is reachable by
# every local process, including the agent's own shell, so only a real login
# session may perform them.
HUMAN_ONLY_ROUTES = frozenset({
    "/client-git-revert.json",
    "/client-project-settings.json",
    "/client-provider-config.json",
    "/client-remote-action.json",
    "/client-task-sandbox.json",
    "/client-worktree-merge.json",
})
HUMAN_ONLY_API_ROOTS = frozenset({"auth", "config", "mcp", "provider"})
HUMAN_ONLY_API_SEGMENTS = frozenset({"command", "permission", "permissions"})


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # Bound every client-socket read/write so a stalled or slow-loris peer
    # cannot pin a worker thread indefinitely.
    timeout = 60

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write(f"{fmt % args}\n")

    def setup(self) -> None:
        super().setup()
        self.rfile = BodyCountingReader(self.rfile)

    def handle(self) -> None:
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError):
            # A browser dropping an idle keep-alive connection is not an error.
            self.close_connection = True

    def parse_request(self) -> bool:
        if not super().parse_request():
            return False
        # Everything read so far was the request line and headers.
        if isinstance(self.rfile, BodyCountingReader):
            self.rfile.body_consumed = 0
        rejection = self.request_rejection()
        if rejection is not None:
            status, message = rejection
            self.json_response({"ok": False, "error": message}, status=status)
            return False
        return True

    def request_rejection(self) -> tuple[int, str] | None:
        """Central policy applied to every request before any route handler."""
        if self.headers.get("Transfer-Encoding") is not None:
            # Bodies are framed by Content-Length only; an unread chunked body
            # would be parsed as the next keep-alive request (smuggling).
            return 400, "Transfer-Encoding не поддерживается"
        lengths = self.headers.get_all("Content-Length") or []
        if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]{1,18}", lengths[0].strip())):
            return 400, "Некорректный Content-Length"
        if self.cross_origin_request():
            # Fetch-metadata resource isolation: another site or localhost port
            # may navigate to an application page, never call an endpoint.
            path = urlsplit(self.path).path
            navigation = (
                self.command in ("GET", "HEAD")
                and str(self.headers.get("Sec-Fetch-Mode", "")).strip().lower() == "navigate"
                and not path.startswith(ENDPOINT_PREFIXES)
            )
            if not navigation:
                return 403, "Запрос с другого сайта отклонён"
        if self.command in STATE_CHANGING_METHODS and lengths and int(lengths[0]) > 0:
            # Cross-site "simple" requests can only send form or text bodies.
            media_type = str(self.headers.get("Content-Type", "")).split(";", 1)[0].strip().lower()
            if media_type != "application/json":
                return 415, "Ожидается Content-Type: application/json"
        return None

    def cross_origin_request(self) -> bool:
        """A browser-marked request initiated by another origin (site or port)."""
        site = str(self.headers.get("Sec-Fetch-Site", "")).strip().lower()
        if site and site not in ("same-origin", "none"):
            return True
        origin = self.headers.get("Origin")
        return origin is not None and not self.origin_allowed(str(origin))

    def origin_allowed(self, value: str) -> bool:
        origin = parse_origin(value)
        if origin is None:
            return False
        if origin in ALLOWED_ORIGINS:
            return True
        return any(origin_matches_authority(origin, authority) for authority in self.request_authorities())

    def request_authorities(self) -> list[tuple[str, int | None]]:
        values = [str(self.headers.get("Host", ""))]
        if is_loopback(self.client_address[0]):
            # Only a same-host reverse proxy may name the public host it serves.
            values.append(str(self.headers.get("X-Forwarded-Host", "")).split(",", 1)[0])
            for item in str(self.headers.get("Forwarded", "")).split(",", 1)[0].split(";"):
                key, _, value = item.partition("=")
                if key.strip().lower() == "host":
                    values.append(value.strip().strip('"'))
        return [authority for value in values if (authority := parse_authority(value))]

    def request_body_pending(self) -> bool:
        headers = getattr(self, "headers", None)
        if headers is None:
            return False
        try:
            expected = int(headers.get("Content-Length") or 0)
        except ValueError:
            return True
        return getattr(self.rfile, "body_consumed", expected) < expected

    def end_headers(self) -> None:
        if not self.close_connection and self.request_body_pending():
            # An unread request body would be parsed as the next request.
            self.send_header("Connection", "close")
        super().end_headers()

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
        """Passwordless loopback only for a direct localhost request.

        A local reverse proxy also connects from 127.0.0.1, so trusting the TCP
        peer alone would turn every proxied LAN request into localhost.
        Forwarding headers or a non-loopback Host therefore disable bypass.
        A page on another site or localhost port also makes loopback requests
        through the browser: requests the browser marks as cross-origin never
        qualify, only local tools and this app's own same-origin pages.
        """
        if not ALLOW_LOCAL or not is_loopback(self.client_address[0]):
            return False
        if any(self.headers.get(name) for name in FORWARDING_HEADER_NAMES):
            return False
        if self.cross_origin_request():
            return False
        host_header = str(self.headers.get("Host", "")).strip()
        try:
            host = urlsplit(f"//{host_header}").hostname or ""
        except ValueError:
            return False
        return is_loopback(host)

    def requires_human_session(self) -> bool:
        """Consent/credential/destructive request: a login cookie is required."""
        if self.command not in STATE_CHANGING_METHODS:
            return False
        route = self.normalized_route(self.path)
        if not route:
            return True  # Unparseable security route: fail closed.
        lowered = route.lower()
        if lowered in HUMAN_ONLY_ROUTES:
            return True
        parts = lowered.split("/")
        if len(parts) > 2 and parts[1] == "api" and (
            parts[2] in HUMAN_ONLY_API_ROOTS or any(part in HUMAN_ONLY_API_SEGMENTS for part in parts[2:])
        ):
            return True
        return self.form_reply_requires_human(route)

    def authenticated(self) -> bool:
        if self.requires_human_session():
            return self.authenticated_human()
        if self.local_bypass():
            return True
        return self.authenticated_human()

    def authenticated_human(self) -> bool:
        """Authentication that cannot be satisfied by the loopback bypass."""
        token = self.cookie_token()
        if token and valid_session_token(token):
            return True
        if ALLOW_BASIC_AUTH:
            supplied = self.headers.get("Authorization", "")
            if not supplied:
                return False
            # Parse Basic auth
            try:
                scheme, _, encoded = supplied.partition(" ")
                if scheme.lower() != "basic":
                    return False
                decoded = base64.b64decode(encoded).decode("utf-8")
                username, _, password = decoded.partition(":")
                return server_users.authenticate(username, password)
            except Exception:
                return False
        return False

    def form_reply_requires_human(self, path: str) -> bool:
        """Subclass hook for forms that carry a security-sensitive decision."""
        return False

    @staticmethod
    def normalized_route(path: str) -> str:
        """Decode every path segment before a security route comparison."""
        try:
            decoded = unquote(urlsplit(path).path)
        except (TypeError, ValueError):
            return ""
        if not decoded.startswith("/") or "\x00" in decoded:
            return ""
        parts = decoded.split("/")
        if any(part in {".", ".."} for part in parts):
            return ""
        return "/" + "/".join(part for part in parts if part)

    def request_is_secure(self) -> bool:
        if AUTH_COOKIE_SECURE in ("1", "true", "yes"):
            return True
        if AUTH_COOKIE_SECURE in ("0", "false", "no"):
            return False
        # Auto mode: only a reverse proxy on the same host may declare the
        # external scheme; a directly connected remote client could otherwise
        # forge X-Forwarded-Proto to influence cookie hardening.
        if not is_loopback(self.client_address[0]):
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
        error = "Требуется авторизация"
        if self.requires_human_session() and self.local_bypass():
            error = "Требуется вход по паролю: локальный доступ без пароля не подтверждает это действие"
        self.json_response({"ok": False, "error": error}, status=401)

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
        try:
            accepted = server_users.authenticate(username, password)
        except Exception:
            accepted = False
        if not accepted:
            time.sleep(0.35)
            self.json_response({"ok": False, "error": "Неверный логин или пароль"}, status=401)
            return

        ttl = AUTH_REMEMBER_SECONDS if remember else AUTH_SESSION_SECONDS
        token = issue_session_token(ttl, username)
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

    def provider_config(self) -> None:
        values = read_env_file(CUSTOM_ENV_FILE)
        self.json_response(
            {
                "ok": True,
                "provider": "qwen-token-plan",
                "baseUrl": values.get(
                    "TOKEN_PLAN_OPENAI_BASE_URL",
                    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
                ),
                "model": values.get("TOKEN_PLAN_PROBE_MODEL", "qwen3.8-max"),
                "keySet": bool(values.get("TOKEN_PLAN_API_KEY", "").strip()),
            }
        )

    def update_provider_config(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            self.json_response({"ok": False, "error": "Некорректный запрос"}, status=400)
            return
        if payload.get("provider") != "qwen-token-plan":
            self.json_response({"ok": False, "error": "Неизвестный провайдер"}, status=400)
            return

        values = read_env_file(CUSTOM_ENV_FILE)
        raw_key = payload.get("apiKey")
        api_key = raw_key.strip() if isinstance(raw_key, str) else ""
        if not api_key:
            api_key = values.get("TOKEN_PLAN_API_KEY", "").strip()
        if not re.fullmatch(r"sk-[A-Za-z0-9._-]{16,397}", api_key):
            self.json_response(
                {"ok": False, "error": "Нужен рабочий ключ Alibaba Token Plan формата sk-..."},
                status=400,
            )
            return

        model = str(payload.get("model") or values.get("TOKEN_PLAN_PROBE_MODEL") or "qwen3.8-max").strip()
        if not re.fullmatch(r"[A-Za-z0-9._:/-]{1,200}", model):
            self.json_response({"ok": False, "error": "Некорректное имя модели"}, status=400)
            return

        try:
            configure_qwen_token_plan(api_key, model)
        except (OSError, RuntimeError):
            self.json_response(
                {"ok": False, "error": "Ключ сохранён локально, но backend не удалось перезапустить"},
                status=502,
            )
            return
        self.json_response({"ok": True, "provider": "qwen-token-plan", "model": model, "keySet": True})

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
            # Extract username from token or use CLIENT_USER for local/bypass/basic
            username = CLIENT_USER
            token = self.cookie_token()
            if token:
                token_user = valid_session_token(token)
                if token_user:
                    username = token_user
            self.json_response({
                "ok": True,
                "user": username,
                "localBypass": self.local_bypass(),
                # A real login session; consent actions need it even locally.
                "human": self.authenticated_human(),
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
        if path == "/client-rate-limit.json":
            rate_limit_path = Path.home() / ".local/state/custom-opencode/rate-limit.json"
            data = {"active": False, "seconds": 0}
            try:
                if rate_limit_path.is_file():
                    content = rate_limit_path.read_text(encoding="utf-8")
                    if content.strip():
                        data = json.loads(content)
            except Exception:
                pass
            self.json_response(data)
            return
        if path == "/client-provider-config.json":
            self.provider_config()
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
        # authenticated() refuses the loopback bypass for consent boundaries,
        # including budget-approval forms; ordinary native questions keep it.
        if not self.authenticated():
            self.unauthorized()
            return
        if path == "/client-provider-config.json":
            self.update_provider_config()
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
        relative = static_relative_path(path)
        asset = static_asset(relative) if relative is not None else None
        if asset is None:
            self.send_error(404)
            return
        compressed = asset.gzip_body is not None and accepts_gzip(str(self.headers.get("Accept-Encoding", "")))
        # Each representation needs its own strong validator.
        etag = f'{asset.etag[:-1]}-gz"' if compressed else asset.etag
        status = 304 if etag_matches(self.headers.get("If-None-Match"), etag) else 200
        self.send_response(status)
        if status == 200:
            self.send_header("Content-Type", asset.content_type)
            if compressed:
                self.send_header("Content-Encoding", "gzip")
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "no-cache")
        if asset.gzip_body is not None:
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        if asset.csp:
            self.send_header("Content-Security-Policy", asset.csp)
        if status == 304:
            self.end_headers()
            return
        body = asset.gzip_body if compressed else asset.body
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True

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
        try: self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError): pass

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
        if length > MAX_PROXY_BODY_BYTES:
            self.send_error(413, "Request body too large")
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
            if key.lower() not in HOP_BY_HOP
            and key.lower() not in ("authorization", "content-length", "cookie")
            and key.lower() not in FORWARDED_HEADERS
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
                self.send_backend_headers(response)
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
            self.send_backend_headers(response)
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

    def send_backend_headers(self, response: http.client.HTTPResponse) -> None:
        has_sniff_guard = False
        for key, value in response.getheaders():
            lowered = key.lower()
            if lowered in HOP_BY_HOP or lowered == "content-length":
                continue
            has_sniff_guard = has_sniff_guard or lowered == "x-content-type-options"
            self.send_header(key, value)
        if not has_sniff_guard:
            # Proxied bodies (e.g. file contents) must never be sniffed as HTML.
            self.send_header("X-Content-Type-Options", "nosniff")


def main() -> None:
    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    server = ThreadingWebServer((WEB_HOST, WEB_PORT), Handler)
    print(f"OpenCode web client started on configured port {WEB_PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
