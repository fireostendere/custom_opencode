#!/usr/bin/env python3
"""Control the custom web client user service without exposing secrets."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any


UNIT = "opencode-web-client.service"
ENABLED_STATES = {"enabled", "enabled-runtime", "alias", "indirect", "generated"}


class ControlError(RuntimeError):
    pass


def _load_server_users():
    """Lazy import of server_users module."""
    root = root_directory()
    spec = importlib.util.spec_from_file_location(
        "server_users",
        root / "app" / "server_users.py"
    )
    if spec is None or spec.loader is None:
        raise ControlError("cannot load server_users module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def root_directory() -> Path:
    configured = os.environ.get("CUSTOM_OPENCODE_ROOT", "").strip()
    root = Path(configured).expanduser() if configured else Path(__file__).resolve().parents[1]
    root = root.resolve()
    if not (root / "scripts" / "install.sh").is_file():
        raise ControlError(f"custom_opencode root is not available: {root}")
    return root


def state_path() -> Path:
    configured = os.environ.get("OPENCODE_WEBSERVER_STATE", "").strip()
    if configured:
        return Path(configured).expanduser()
    config_home = Path(os.environ.get("XDG_CONFIG_HOME", "").strip() or "~/.config").expanduser()
    return config_home / "opencode" / "webserver.json"


def unit_path() -> Path:
    return Path(os.environ.get("HOME", "~")).expanduser() / ".config" / "systemd" / "user" / UNIT


def read_state() -> dict[str, Any]:
    path = state_path()
    if path.is_symlink() or path.is_dir():
        raise ControlError(f"unsafe webserver state path: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        raise ControlError(f"cannot read webserver state: {exc}") from exc
    return value if isinstance(value, dict) else {}


def write_state(values: dict[str, Any]) -> None:
    path = state_path()
    if path.is_symlink() or path.is_dir():
        raise ControlError(f"unsafe webserver state path: {path}")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(values, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)
    path.chmod(0o600)


def systemctl_binary() -> str:
    binary = os.environ.get("OPENCODE_SYSTEMCTL_BIN") or shutil.which("systemctl")
    if not binary:
        raise ControlError("systemctl is not available")
    return binary


def systemctl(*arguments: str, timeout: float = 20.0) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            [systemctl_binary(), "--user", *arguments],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ControlError(f"systemctl {' '.join(arguments)} failed: {exc}") from exc


def checked_systemctl(*arguments: str) -> None:
    result = systemctl(*arguments)
    if result.returncode:
        detail = (result.stderr or result.stdout).strip().splitlines()
        raise ControlError(detail[-1] if detail else f"systemctl {' '.join(arguments)} exited {result.returncode}")


def probe(*arguments: str) -> str | None:
    try:
        result = systemctl(*arguments)
    except ControlError:
        return None
    if result.returncode:
        return ""
    return result.stdout.strip().splitlines()[0] if result.stdout.strip() else ""


def web_config() -> tuple[str, int]:
    host = os.environ.get("OPENCODE_WEB_HOST", "localhost")
    try:
        port = int(os.environ.get("OPENCODE_WEB_PORT", "4098"))
    except ValueError:
        port = 4098
    return host, port


def status() -> dict[str, Any]:
    saved = read_state()
    active = probe("is-active", UNIT)
    enabled = probe("is-enabled", UNIT)
    deployed = unit_path().is_file()
    running = active == "active" if active is not None else bool(saved.get("running", False))
    default_enabled = enabled in ENABLED_STATES if enabled is not None else bool(saved.get("defaultEnabled", False))
    host, port = web_config()
    result = {
        "ok": True,
        "unit": UNIT,
        "deployed": deployed,
        "running": running,
        "defaultEnabled": default_enabled,
        "host": host,
        "port": port,
        "address": f"http://{host}:{port}",
        "statePath": str(state_path()),
    }
    # Best-effort users list. list_users() is lenient (env user survives a
    # corrupt store), so probe the store explicitly to surface usersError.
    try:
        server_users = _load_server_users()
        result["users"] = server_users.list_users()
        server_users.read_users()
    except Exception as exc:
        result.setdefault("users", [])
        result["usersError"] = str(exc)
    return result


def require_deployed() -> None:
    if not unit_path().is_file():
        raise ControlError("web server is not deployed")


def apply(running: bool, default_enabled: bool) -> dict[str, Any]:
    require_deployed()
    checked_systemctl("daemon-reload")
    checked_systemctl("enable" if default_enabled else "disable", UNIT)
    checked_systemctl("start" if running else "stop", UNIT)
    previous = read_state()
    saved = {
        **previous,
        "version": 1,
        "deployed": True,
        "running": running,
        "defaultEnabled": default_enabled,
    }
    write_state(saved)
    return status()


def deploy(running: bool, default_enabled: bool) -> dict[str, Any]:
    root = root_directory()
    try:
        result = subprocess.run(
            ["bash", str(root / "scripts" / "install.sh")],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=float(os.environ.get("OPENCODE_WEBSERVER_DEPLOY_TIMEOUT", "1800")),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ControlError(f"web server deploy failed: {exc}") from exc
    if result.returncode:
        output = (result.stderr or result.stdout).strip().splitlines()
        raise ControlError(output[-1] if output else f"install.sh exited {result.returncode}")
    return apply(running, default_enabled)


def user_list() -> dict[str, Any]:
    """List all users."""
    server_users = _load_server_users()
    return {"ok": True, "users": server_users.list_users()}


def user_add(username: str, password: str | None) -> dict[str, Any]:
    """Add a user. If password is None, generate one."""
    server_users = _load_server_users()
    generated = False
    if password is None:
        password = server_users.generate_password()
        generated = True
    server_users.add_user(username, password)
    result = {"ok": True, "username": username, "users": server_users.list_users()}
    if generated:
        result["generatedPassword"] = password
    return result


def user_remove(username: str) -> dict[str, Any]:
    """Remove a user."""
    server_users = _load_server_users()
    server_users.remove_user(username)
    return {"ok": True, "username": username, "users": server_users.list_users()}


def _rewrite_env_file(port: int, host: str | None) -> None:
    """Rewrite .env file with new port/host values. Preserve other lines."""
    root = root_directory()
    env_path = root / ".env"
    if env_path.is_symlink() or env_path.is_dir():
        raise ControlError(f"unsafe .env path: {env_path}")
    if not env_path.is_file():
        raise ControlError(f".env file not found: {env_path}")

    try:
        content = env_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ControlError(f"cannot read .env: {exc}") from exc

    lines = content.splitlines()
    new_lines = []
    port_found = False
    host_found = False
    # Capture optional "export " prefix to preserve it
    port_re = re.compile(r"^(\s*(?:export\s+)?)OPENCODE_WEB_PORT\s*=")
    host_re = re.compile(r"^(\s*(?:export\s+)?)OPENCODE_WEB_HOST\s*=")

    for line in lines:
        port_match = port_re.match(line)
        host_match = host_re.match(line)
        if port_match:
            prefix = port_match.group(1)
            new_lines.append(f"{prefix}OPENCODE_WEB_PORT={port}")
            port_found = True
        elif host_match:
            if host is not None:
                prefix = host_match.group(1)
                new_lines.append(f"{prefix}OPENCODE_WEB_HOST={host}")
                host_found = True
            else:
                new_lines.append(line)
        else:
            new_lines.append(line)

    # Append missing keys
    if not port_found:
        new_lines.append(f"OPENCODE_WEB_PORT={port}")
    if host is not None and not host_found:
        new_lines.append(f"OPENCODE_WEB_HOST={host}")

    # Atomic write preserving mode using mkstemp + fsync
    try:
        stat_info = env_path.stat()
        mode = stat_info.st_mode
    except OSError:
        mode = 0o644

    import tempfile
    fd = None
    tmp_path = None
    try:
        fd, tmp_path = tempfile.mkstemp(dir=env_path.parent, prefix=f".{env_path.name}.", suffix=".tmp")
        os.write(fd, ("\n".join(new_lines) + "\n").encode("utf-8"))
        os.fsync(fd)
        os.close(fd)
        fd = None
        os.chmod(tmp_path, mode & 0o777)
        os.replace(tmp_path, env_path)
        tmp_path = None
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
        raise ControlError(f"cannot write .env: {exc}") from exc


def port_command(port: int, host: str | None) -> dict[str, Any]:
    """Set port (and optionally host). Restart service if active."""
    if not (1 <= port <= 65535):
        raise ControlError(f"port must be 1..65535, got {port}")
    if host is not None:
        if not host or " " in host or "/" in host or ":" in host:
            raise ControlError(f"invalid host: {host!r} (no spaces, slashes, or colons)")

    _rewrite_env_file(port, host)

    # Check if service is active and restart if needed
    restarted = False
    active = probe("is-active", UNIT)
    if active == "active":
        try:
            checked_systemctl("restart", UNIT)
            restarted = True
        except ControlError:
            pass

    # Reload web config to get effective values
    # (the env vars in current process don't reflect the change)
    effective_host = host if host is not None else os.environ.get("OPENCODE_WEB_HOST", "localhost")
    return {
        "ok": True,
        "host": effective_host,
        "port": port,
        "restarted": restarted,
        "address": f"http://{effective_host}:{port}",
    }


def parse_bool(value: str) -> bool:
    if value == "on":
        return True
    if value == "off":
        return False
    raise argparse.ArgumentTypeError("expected on or off")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Control custom_opencode web server")
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    for name in ("deploy", "apply"):
        command = commands.add_parser(name)
        command.add_argument("--running", required=True, type=parse_bool, metavar="on|off")
        command.add_argument("--default", required=True, type=parse_bool, dest="default_enabled", metavar="on|off")
    commands.add_parser("start")
    commands.add_parser("stop")
    default = commands.add_parser("default")
    default.add_argument("value", type=parse_bool, metavar="on|off")

    # User management commands
    commands.add_parser("user-list")

    user_add_parser = commands.add_parser("user-add")
    user_add_parser.add_argument("--username", required=True)
    user_add_parser.add_argument("--password", default=None)

    user_remove_parser = commands.add_parser("user-remove")
    user_remove_parser.add_argument("--username", required=True)

    # Port configuration
    port_parser = commands.add_parser("port")
    port_parser.add_argument("--port", required=True, type=int)
    port_parser.add_argument("--host", default=None)

    return root


def main(argv: list[str] | None = None) -> int:
    try:
        args = parser().parse_args(argv)
    except SystemExit as e:
        # argparse calls sys.exit on error; convert to JSON envelope
        if e.code == 0:
            return 0
        # Build short usage summary
        try:
            usage = parser().format_usage().splitlines()[0]
        except Exception:
            usage = "invalid arguments"
        print(json.dumps({"ok": False, "error": f"invalid arguments: {usage}"}, ensure_ascii=False))
        return 1
    try:
        if args.command == "status":
            result = status()
        elif args.command == "deploy":
            result = deploy(args.running, args.default_enabled)
        elif args.command == "apply":
            result = apply(args.running, args.default_enabled)
        elif args.command == "start":
            current = status()
            result = apply(True, current["defaultEnabled"])
        elif args.command == "stop":
            current = status()
            result = apply(False, current["defaultEnabled"])
        elif args.command == "default":
            current = status()
            result = apply(current["running"], args.value)
        elif args.command == "user-list":
            result = user_list()
        elif args.command == "user-add":
            result = user_add(args.username, args.password)
        elif args.command == "user-remove":
            result = user_remove(args.username)
        elif args.command == "port":
            result = port_command(args.port, args.host)
        else:
            raise ControlError(f"unknown command: {args.command}")
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (ControlError, OSError, ValueError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
