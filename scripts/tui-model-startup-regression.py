#!/usr/bin/env python3
"""Focused regression for restoring the custom selector's TUI startup model."""

import json
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile


HELPER = Path(__file__).with_name("restore-tui-model.py")


def run(state: Path, *args: str, home: Path | None = None, cwd: Path | None = None) -> None:
    env = os.environ | {"XDG_STATE_HOME": str(state), "HOME": str(home or state / "home")}
    subprocess.run([sys.executable, str(HELPER), *args], env=env, cwd=cwd, check=True)


def dump(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


with tempfile.TemporaryDirectory() as temporary:
    state = Path(temporary) / "xdg-state"
    root = state / "opencode"
    custom = root / "beta/tui/plugin.custom.tui-bundle.model-selector.recent.json"
    native = root / "model.json"
    workspace = Path(temporary) / "workspace with spaces"
    workspace.mkdir()
    (workspace / "models").mkdir()
    dump(custom, {"models": [{"providerID": "openai", "modelID": "astra"}]})
    dump(native, {"recent": [{"providerID": "openai", "modelID": "luna"}, {"providerID": "openai", "modelID": "astra"}], "favorite": ["keep"], "variant": {"openai/astra": "high"}, "unknown": {"keep": True}})
    run(state)
    restored = json.loads(native.read_text())
    assert restored["recent"] == [{"providerID": "openai", "modelID": "astra"}, {"providerID": "openai", "modelID": "luna"}]
    assert restored["favorite"] == ["keep"] and restored["variant"] == {"openai/astra": "high"} and restored["unknown"] == {"keep": True}
    assert native.stat().st_mode & 0o777 == 0o600
    before = native.read_bytes()
    run(state)
    assert native.read_bytes() == before

    dump(native, {"recent": [{"providerID": "test", "modelID": str(index)} for index in range(10)]})
    run(state)
    assert len(json.loads(native.read_text())["recent"]) == 10

    for args in ((), ("--standalone", str(workspace)), ("--auto",), ("--server", "http://localhost"), ("--prompt", "service"), ("--log-level=debug",), ("--print-logs",)):
        dump(native, {"recent": [{"providerID": "openai", "modelID": "luna"}]})
        run(state, *args)
        assert json.loads(native.read_text())["recent"][0]["modelID"] == "astra", args
    for args in (("acp",), ("api",), ("debug",), ("console",), ("auth",), ("mcp",), ("plugin",), ("models",), ("stats",), ("export",), ("import",), ("mini",), ("run",), ("service",), ("pair",), ("serve",), ("wizard",), ("completions",), ("resume",), ("--help",), ("--continue",), ("--session", "id"), ("--model", "openai/luna"), ("--agent", "plan"), ("--unknown",), ("not-a-directory",)):
        dump(native, {"recent": [{"providerID": "openai", "modelID": "luna"}]})
        run(state, *args, cwd=workspace)
        assert json.loads(native.read_text())["recent"][0]["modelID"] == "luna", args

    home = Path(temporary) / "empty-xdg-home"
    fallback = home / ".local/state/opencode"
    dump(fallback / "beta/tui/plugin.custom.tui-bundle.model-selector.recent.json", {"models": [{"providerID": "openai", "modelID": "astra"}]})
    dump(fallback / "model.json", {"recent": [{"providerID": "openai", "modelID": "luna"}]})
    subprocess.run(
        [sys.executable, str(HELPER)],
        env=os.environ | {"XDG_STATE_HOME": "", "HOME": str(home)},
        check=True,
    )
    assert json.loads((fallback / "model.json").read_text())["recent"][0]["modelID"] == "astra"

    dump(custom, {"models": [{"providerID": "openai", "modelID": "astra"}]})
    dump(native, {"recent": [{"providerID": "openai", "modelID": "luna"}]})
    spec = importlib.util.spec_from_file_location("restore_tui_model", HELPER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    original_fsync, original_argv = module.os.fsync, module.sys.argv
    try:
        module.os.fsync = lambda fd: native.write_text('{"recent":[{"providerID":"openai","modelID":"writer"}]}')
        module.sys.argv = [str(HELPER)]
        old_state = os.environ.get("XDG_STATE_HOME")
        os.environ["XDG_STATE_HOME"] = str(state)
        assert module.main() == 0
    finally:
        module.os.fsync, module.sys.argv = original_fsync, original_argv
        if old_state is None: os.environ.pop("XDG_STATE_HOME", None)
        else: os.environ["XDG_STATE_HOME"] = old_state
    assert json.loads(native.read_text())["recent"][0]["modelID"] == "writer"
    assert not list(native.parent.glob(".model.*.json"))

    dump(native, {"recent": [{"providerID": "openai", "modelID": "luna"}]})
    custom.write_bytes(b"\xff")
    run(state)
    assert json.loads(native.read_text())["recent"][0]["modelID"] == "luna"
    dump(custom, {"models": [{"providerID": "openai", "modelID": "astra"}]})
    native.write_text("{bad", encoding="utf-8")
    run(state)
    assert native.read_text() == "{bad"
    native.unlink()
    custom.write_text("{bad", encoding="utf-8")
    run(state)
    assert not native.exists()
    dump(custom, {"models": [{"providerID": "", "modelID": "astra"}]})
    run(state)
    assert not native.exists()

print("TUI model startup regression passed: TUI args, XDG fallback, restore, concurrent-write skip, malformed state")
