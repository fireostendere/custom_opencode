#!/usr/bin/env python3
"""Exercise webserver-control.py with an isolated fake user systemd."""

from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
CONTROL = ROOT / "scripts" / "webserver-control.py"


def run_control(arguments: list[str], env: dict[str, str]) -> tuple[int, dict[str, object]]:
    result = subprocess.run(
        [sys.executable, str(CONTROL), *arguments],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        value = json.loads(result.stdout)
    except ValueError as exc:
        raise AssertionError(f"invalid controller output: {result.stdout!r}; stderr={result.stderr!r}") from exc
    return result.returncode, value


def main() -> int:
    scratch = os.environ.get("CUSTOM_OPENCODE_TEST_TMP")
    if scratch:
        Path(scratch).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="custom-opencode-webserver-smoke-", dir=scratch) as temporary:
        root = Path(temporary)
        home = root / "home"
        unit = home / ".config" / "systemd" / "user" / "opencode-web-client.service"
        unit.parent.mkdir(parents=True)
        unit.write_text("[Unit]\n", encoding="utf-8")
        fake_state = root / "systemd.json"
        fake_systemctl = root / "systemctl"
        fake_systemctl.write_text(
            """#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
path = Path(os.environ['FAKE_SYSTEMD_STATE'])
state = json.loads(path.read_text()) if path.exists() else {'running': False, 'default': False}
args = sys.argv[1:]
assert args.pop(0) == '--user'
command = args.pop(0)
if command == 'daemon-reload':
    pass
elif command == 'is-active':
    if state['running']:
        print('active')
    else:
        print('inactive')
        sys.exit(3)
elif command == 'is-enabled':
    if state['default']:
        print('enabled')
    else:
        print('disabled')
        sys.exit(1)
elif command == 'enable':
    state['default'] = True
elif command == 'disable':
    state['default'] = False
elif command == 'start':
    state['running'] = True
elif command == 'stop':
    state['running'] = False
else:
    raise SystemExit(f'unsupported systemctl command: {command}')
path.write_text(json.dumps(state))
""",
            encoding="utf-8",
        )
        fake_systemctl.chmod(0o755)
        state_path = root / "config" / "opencode" / "webserver.json"
        mode_probe = root / "mode-probe"
        mode_probe.write_text("probe", encoding="utf-8")
        mode_probe.chmod(0o600)
        supports_private_modes = stat.S_IMODE(mode_probe.stat().st_mode) == 0o600
        env = {
            **os.environ,
            "HOME": str(home),
            "OPENCODE_SYSTEMCTL_BIN": str(fake_systemctl),
            "FAKE_SYSTEMD_STATE": str(fake_state),
            "OPENCODE_WEBSERVER_STATE": str(state_path),
            "OPENCODE_WEB_HOST": "127.0.0.1",
            "OPENCODE_WEB_PORT": "4098",
            "CUSTOM_OPENCODE_ROOT": str(ROOT),
        }

        code, value = run_control(["status"], env)
        assert code == 0 and value["deployed"] is True
        assert value["running"] is False and value["defaultEnabled"] is False

        code, value = run_control(["apply", "--running", "on", "--default", "on"], env)
        assert code == 0 and value["running"] is True and value["defaultEnabled"] is True
        if supports_private_modes:
            assert stat.S_IMODE(state_path.stat().st_mode) == 0o600

        code, value = run_control(["default", "off"], env)
        assert code == 0 and value["running"] is True and value["defaultEnabled"] is False

        code, value = run_control(["stop"], env)
        assert code == 0 and value["running"] is False and value["defaultEnabled"] is False

        unit.unlink()
        code, value = run_control(["apply", "--running", "on", "--default", "on"], env)
        assert code == 1 and value["ok"] is False and "not deployed" in str(value["error"])

    print("Webserver control smoke passed: status + current/default lifecycle + state permissions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
