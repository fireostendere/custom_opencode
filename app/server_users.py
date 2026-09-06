#!/usr/bin/env python3
"""Multi-user accounts store and authentication primitives.

Standalone stdlib-only module. No imports from other app modules.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import stat
import tempfile
import time
from pathlib import Path
from typing import Any


class UsersError(ValueError):
    """Safe user-store error. Never includes passwords in messages."""


USERNAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
MIN_PASSWORD_LENGTH = 8
DEFAULT_ITERATIONS = 210_000


def users_path() -> Path:
    """Path to the users store file.

    Env OPENCODE_USERS_FILE (expanduser) else XDG_CONFIG_HOME/opencode/users.json.
    Refuses symlink/dir at read/write time (caller must check).
    """
    configured = os.environ.get("OPENCODE_USERS_FILE", "").strip()
    if configured:
        return Path(configured).expanduser()
    config_home = Path(os.environ.get("XDG_CONFIG_HOME", "").strip() or "~/.config").expanduser()
    return config_home / "opencode" / "users.json"


def _atomic_write_text(path: Path, content: str, mode: int = 0o600) -> None:
    """Atomically write text to a file with fsync.
    
    Uses tempfile.mkstemp for unique names, os.fsync for durability,
    and os.replace for atomic rename.
    """
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = None
    tmp_path = None
    try:
        fd, tmp_path = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
        os.write(fd, content.encode("utf-8"))
        os.fsync(fd)
        os.close(fd)
        fd = None
        os.chmod(tmp_path, mode)
        os.replace(tmp_path, path)
    except OSError as exc:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        raise exc


def _secret_path() -> Path:
    """Sibling auth-secret.key file, created on first use."""
    return users_path().with_name("auth-secret.key")


def server_secret() -> str:
    """64-hex random secret persisted at sibling auth-secret.key.

    Created on first use with 0600, parent mkdir 0700, atomic write.
    """
    path = _secret_path()
    if path.is_symlink() or path.is_dir():
        raise UsersError(f"unsafe secret path: {path}")
    if path.is_file():
        try:
            value = path.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise UsersError(f"cannot read secret: {exc}") from exc
        if len(value) == 64 and all(c in "0123456789abcdef" for c in value):
            return value
    # Generate new secret
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    secret = secrets.token_hex(32)
    import tempfile
    fd = None
    tmp_path = None
    try:
        fd, tmp_path = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
        os.write(fd, (secret + "\n").encode("utf-8"))
        os.fsync(fd)
        os.close(fd)
        fd = None
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, path)
        tmp_path = None
    except OSError as exc:
        if fd is not None:
            os.close(fd)
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        raise UsersError(f"cannot write secret: {exc}") from exc
    return secret


def _hash_password(password: str, salt: str, iterations: int = DEFAULT_ITERATIONS) -> str:
    """PBKDF2-SHA256 hash, returns hex digest."""
    return hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        bytes.fromhex(salt),
        iterations,
    ).hex()


def _env_credentials() -> tuple[str, str]:
    """Read (username, password) from env at CALL time.

    Defaults: username="opencode", password="".
    """
    user = os.environ.get("OPENCODE_SERVER_USERNAME", "opencode")
    password = os.environ.get("OPENCODE_SERVER_PASSWORD", "")
    return user, password


def read_users() -> list[dict[str, Any]]:
    """Read users from store with stat-based cache.

    Returns list of user dicts: {"username", "salt", "hash", "iterations", "created_at"}.
    Raises UsersError on invalid/corrupt file.
    """
    path = users_path()
    if path.is_symlink() or path.is_dir():
        raise UsersError(f"unsafe users path: {path}")
    try:
        st = path.stat()
    except FileNotFoundError:
        return []
    except OSError as exc:
        raise UsersError(f"cannot stat users file: {exc}") from exc

    cache_key = (st.st_mtime_ns, st.st_size)
    cached = _read_users_cache.get("value")
    if cached is not None and cached["key"] == cache_key:
        return cached["data"]

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as exc:
        raise UsersError(f"cannot read users file: {exc}") from exc

    if not isinstance(raw, dict):
        raise UsersError("users file must be a JSON object")
    if raw.get("version") != 1:
        raise UsersError(f"unsupported users file version: {raw.get('version')}")
    users = raw.get("users")
    if not isinstance(users, list):
        raise UsersError("users file must contain a 'users' array")

    # Validate each user
    validated: list[dict[str, Any]] = []
    for user in users:
        if not isinstance(user, dict):
            raise UsersError("each user must be an object")
        username = user.get("username")
        salt = user.get("salt")
        hash_hex = user.get("hash")
        iterations = user.get("iterations")
        created_at = user.get("created_at")
        if not isinstance(username, str) or not USERNAME_RE.fullmatch(username):
            raise UsersError(f"invalid username: {username!r}")
        if not isinstance(salt, str) or len(salt) != 32 or not all(c in "0123456789abcdef" for c in salt):
            raise UsersError(f"invalid salt for user {username!r}")
        if not isinstance(hash_hex, str) or len(hash_hex) != 64 or not all(c in "0123456789abcdef" for c in hash_hex):
            raise UsersError(f"invalid hash for user {username!r}")
        if not isinstance(iterations, int) or iterations < 1:
            raise UsersError(f"invalid iterations for user {username!r}")
        if not isinstance(created_at, int):
            raise UsersError(f"invalid created_at for user {username!r}")
        validated.append({
            "username": username,
            "salt": salt,
            "hash": hash_hex,
            "iterations": iterations,
            "created_at": created_at,
        })

    _read_users_cache["value"] = {"key": cache_key, "data": validated}
    return validated


# Module-level stat-based cache for read_users
_read_users_cache: dict[str, Any] = {}


def _write_users(users: list[dict[str, Any]]) -> None:
    """Atomically write users list to store with 0600."""
    path = users_path()
    if path.is_symlink() or path.is_dir():
        raise UsersError(f"unsafe users path: {path}")
    data = {"version": 1, "users": users}
    content = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    try:
        _atomic_write_text(path, content, 0o600)
    except OSError as exc:
        raise UsersError(f"cannot write users file: {exc}") from exc
    # Invalidate cache
    _read_users_cache.pop("value", None)


def authenticate(username: str, password: str) -> bool:
    """Authenticate user against env or store.

    Always performs exactly one PBKDF2 hash to equalize timing.
    """
    env_user, env_password = _env_credentials()

    # Check if this is an env user
    is_env_user = hmac.compare_digest(username, env_user)

    if is_env_user:
        # For env users, do a dummy hash for timing, then check password
        dummy_salt = "0" * 32  # 16 bytes as hex
        _hash_password(password, dummy_salt, DEFAULT_ITERATIONS)
        return hmac.compare_digest(password, env_password)

    # For store users
    try:
        users = read_users()
    except UsersError:
        # Store read error → dummy hash
        dummy_salt = secrets.token_hex(16)
        _hash_password(password, dummy_salt, DEFAULT_ITERATIONS)
        return False

    # Look for user in store
    found_user = None
    for user in users:
        if hmac.compare_digest(user["username"], username):
            found_user = user
            break

    if found_user is None:
        # Username not found → dummy hash
        dummy_salt = secrets.token_hex(16)
        _hash_password(password, dummy_salt, DEFAULT_ITERATIONS)
        return False

    # User found - hash with real salt
    computed = _hash_password(password, found_user["salt"], found_user["iterations"])
    return hmac.compare_digest(computed, found_user["hash"])


def user_exists(username: str) -> bool:
    """Check if username is env user or in store.

    Store read errors → env check only.
    """
    env_user, _ = _env_credentials()
    if hmac.compare_digest(username, env_user):
        return True
    try:
        users = read_users()
    except UsersError:
        return False
    return any(user["username"] == username for user in users)


def add_user(username: str, password: str) -> list[dict[str, Any]]:
    """Add a new user to the store.

    Validates username/password, rejects duplicates (store AND env).
    Returns list_users() after adding.
    """
    if not USERNAME_RE.fullmatch(username):
        raise UsersError(f"invalid username: {username!r} (must match {USERNAME_RE.pattern})")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise UsersError(f"password too short (minimum {MIN_PASSWORD_LENGTH} characters)")

    env_user, _ = _env_credentials()
    if hmac.compare_digest(username, env_user):
        raise UsersError(f"user {username!r} already exists (environment user)")

    try:
        users = read_users()
    except UsersError:
        users = []

    if any(user["username"] == username for user in users):
        raise UsersError(f"user {username!r} already exists")

    salt = secrets.token_hex(16)
    iterations = DEFAULT_ITERATIONS
    hash_hex = _hash_password(password, salt, iterations)
    created_at = int(time.time())

    users.append({
        "username": username,
        "salt": salt,
        "hash": hash_hex,
        "iterations": iterations,
        "created_at": created_at,
    })
    _write_users(users)
    return list_users()


def remove_user(username: str) -> list[dict[str, Any]]:
    """Remove a user from the store.

    Rejects env user or unknown username.
    Returns list_users() after removing.
    """
    env_user, _ = _env_credentials()
    if hmac.compare_digest(username, env_user):
        raise UsersError("environment user is managed via .env")

    try:
        users = read_users()
    except UsersError as exc:
        raise UsersError(f"cannot read users: {exc}") from exc

    original_len = len(users)
    users = [user for user in users if user["username"] != username]
    if len(users) == original_len:
        raise UsersError(f"user {username!r} not found")

    _write_users(users)
    return list_users()


def list_users() -> list[dict[str, str]]:
    """List all users: env user first (if password set), then store users.

    Returns [{"username", "source": "env"}] and/or [{"username", "source": "store", "created_at"}].
    """
    result: list[dict[str, str]] = []
    env_user, env_password = _env_credentials()
    if env_password:
        result.append({"username": env_user, "source": "env"})

    try:
        users = read_users()
    except UsersError:
        return result

    for user in users:
        result.append({
            "username": user["username"],
            "source": "store",
            "created_at": str(user["created_at"]),
        })
    return result


def generate_password() -> str:
    """Generate 16-char password from letters+digits without ambiguous 0O1lI."""
    alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(16))
