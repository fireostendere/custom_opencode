#!/usr/bin/env python3
"""Pin the dedicated orchestrated Qwen at the top of OpenCode TUI Recent models.

The TUI persists model preferences in XDG_STATE_HOME/opencode/model.json.
Only the ordering of the dedicated alias in `recent` is changed; favorites,
variants, unknown fields, and every other recent entry are preserved.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile

PINNED = {"providerID": "bailian-cli", "modelID": "qwen3.8-orchestrated"}


def state_path() -> Path:
    root = os.environ.get("XDG_STATE_HOME")
    if root:
        return Path(root).expanduser() / "opencode" / "model.json"
    return Path.home() / ".local" / "state" / "opencode" / "model.json"


def same_model(value: object) -> bool:
    return (
        isinstance(value, dict)
        and value.get("providerID") == PINNED["providerID"]
        and value.get("modelID") == PINNED["modelID"]
    )


def main() -> int:
    target = state_path()
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raw = {}
    except (json.JSONDecodeError, OSError):
        # Never destroy a preference file we cannot parse/read.
        return 0

    if not isinstance(raw, dict):
        return 0

    recent = raw.get("recent")
    if not isinstance(recent, list):
        recent = []

    ordered = [dict(PINNED), *(item for item in recent if not same_model(item))]
    if recent == ordered:
        return 0

    raw["recent"] = ordered
    target.parent.mkdir(parents=True, exist_ok=True)
    previous_mode = None
    try:
        previous_mode = target.stat().st_mode & 0o777
    except FileNotFoundError:
        pass

    fd, temporary = tempfile.mkstemp(prefix=".model.", suffix=".json", dir=target.parent)
    temp_path = Path(temporary)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(raw, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        if previous_mode is not None:
            os.chmod(temp_path, previous_mode)
        os.replace(temp_path, target)
    finally:
        temp_path.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
