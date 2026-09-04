#!/usr/bin/env python3
"""Control the custom web client user service without exposing secrets."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Any


UNIT = "opencode-web-client.service"
ENABLED_STATES = {"enabled", "enabled-runtime", "alias", "indirect", "generated"}


class ControlError(RuntimeError):
    pass


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
    return {
        "ok": True,
        "unit": UNIT,
        "deployed": deployed,
        "running": running,
        "defaultEnabled": default_enabled,
        "host": host,
        "port": port,
        "statePath": str(state_path()),
    }


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
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
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
        else:
            current = status()
            result = apply(current["running"], args.value)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (ControlError, OSError, ValueError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
