#!/usr/bin/env python3
"""Make the native beta TUI start from the custom selector's last model."""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile


def state_home() -> Path:
    return Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state")


def tui_launch(args: list[str]) -> bool:
    reserved = {
        "acp", "api", "debug", "console", "auth", "mcp", "plugin", "models",
        "stats", "export", "import", "mini", "run", "service", "pair", "serve",
        "wizard", "completions", "resume",
    }
    value_flags = {"--server", "--prompt", "--log-level"}
    flags = {"--standalone", "--auto", "--print-logs"}
    directory = False
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in {"--help", "-h", "--version", "-v", "--continue", "-c", "--session", "-s", "--model", "-m", "--agent"}:
            return False
        if arg in value_flags:
            index += 1
            if index == len(args):
                return False
        elif any(arg.startswith(f"{flag}=") and len(arg) > len(flag) + 1 for flag in value_flags):
            pass
        elif arg in flags:
            pass
        elif arg.startswith("-") or arg in reserved:
            return False
        elif directory:
            return False
        else:
            try:
                if not Path(arg).is_dir():
                    return False
            except OSError:
                return False
            directory = True
        index += 1
    return True


def valid_model(value: object) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("providerID"), str)
        and bool(value["providerID"])
        and isinstance(value.get("modelID"), str)
        and bool(value["modelID"])
    )


def same_model(value: object, model: dict[str, str]) -> bool:
    return (
        isinstance(value, dict)
        and value.get("providerID") == model["providerID"]
        and value.get("modelID") == model["modelID"]
    )


def main() -> int:
    if not tui_launch(sys.argv[1:]):
        return 0
    root = state_home() / "opencode"
    custom = root / "beta/tui/plugin.custom.tui-bundle.model-selector.recent.json"
    native = root / "model.json"
    try:
        saved = json.loads(custom.read_text(encoding="utf-8"))
        models = saved.get("models") if isinstance(saved, dict) else None
        selected = models[0] if isinstance(models, list) and models else None
        if not valid_model(selected):
            return 0
        selected = {"providerID": selected["providerID"], "modelID": selected["modelID"]}
    except (OSError, UnicodeError, json.JSONDecodeError):
        return 0

    try:
        snapshot = native.read_bytes()
        data = json.loads(snapshot)
    except FileNotFoundError:
        snapshot = None
        data = {}
    except (OSError, UnicodeError, json.JSONDecodeError):
        return 0
    if not isinstance(data, dict):
        return 0

    recent = data.get("recent")
    if not isinstance(recent, list):
        recent = []
    updated = [selected, *(item for item in recent if not same_model(item, selected))][:10]
    if data.get("recent") == updated:
        return 0
    data["recent"] = updated

    try:
        native.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".model.", suffix=".json", dir=native.parent)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        # ponytail: no shared native lock; skip if its state changed before our replace.
        try:
            if native.read_bytes() != snapshot:
                return 0
        except FileNotFoundError:
            if snapshot is not None:
                return 0
        except OSError:
            return 0
        os.replace(temporary, native)
    except (OSError, UnicodeError):
        return 0
    finally:
        if "temporary" in locals():
            try:
                Path(temporary).unlink(missing_ok=True)
            except OSError:
                pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
