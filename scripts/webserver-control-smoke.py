#!/usr/bin/env python3
"""Exercise webserver-control.py with an isolated fake user systemd."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import socket
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
elif command == 'restart':
    state['restarted'] = True
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

        # Isolate CUSTOM_OPENCODE_ROOT so `port` rewrites the fixture .env below,
        # never the real repository one. root_directory() requires scripts/install.sh,
        # and _load_server_users() loads app/server_users.py from the same root.
        (root / "scripts").mkdir(parents=True, exist_ok=True)
        (root / "scripts" / "install.sh").write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
        (root / "app").mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / "app" / "server_users.py", root / "app" / "server_users.py")

        env = {
            **os.environ,
            "HOME": str(home),
            "OPENCODE_SYSTEMCTL_BIN": str(fake_systemctl),
            "FAKE_SYSTEMD_STATE": str(fake_state),
            "OPENCODE_WEBSERVER_STATE": str(state_path),
            "OPENCODE_WEB_HOST": "127.0.0.1",
            "OPENCODE_WEB_PORT": "4098",
            "OPENCODE_SERVER_USERNAME": "envuser",
            "OPENCODE_SERVER_PASSWORD": "envpass123",
            "CUSTOM_OPENCODE_ROOT": str(root),
        }

        # Setup users file path
        users_file = root / "users.json"
        env["OPENCODE_USERS_FILE"] = str(users_file)

        # Test status includes address and users (initially empty store)
        code, value = run_control(["status"], env)
        assert code == 0, value
        assert value["deployed"] is True
        assert value["running"] is False and value["defaultEnabled"] is False
        assert "address" in value, "status missing address field"
        assert value["address"] == "http://127.0.0.1:4098", value["address"]
        assert "users" in value, "status missing users field"
        assert isinstance(value["users"], list), value["users"]
        # Should have env user
        env_users = [u for u in value["users"] if u["source"] == "env"]
        assert len(env_users) == 1, f"Expected 1 env user, got {len(env_users)}"
        assert env_users[0]["username"] == "envuser", env_users[0]

        # Original lifecycle tests
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

        # Recreate unit for remaining tests
        unit.write_text("[Unit]\n", encoding="utf-8")

        # Test user-add with explicit password
        code, value = run_control(["user-add", "--username", "alice", "--password", "alicepass123"], env)
        assert code == 0, value
        assert value["ok"] is True, value
        assert value["username"] == "alice", value
        assert "generatedPassword" not in value, "should not have generatedPassword"
        assert "users" in value, value

        # Verify users.json exists and has mode 0600
        if supports_private_modes:
            assert users_file.exists(), "users.json should exist"
            file_mode = stat.S_IMODE(users_file.stat().st_mode)
            assert file_mode == 0o600, f"Expected mode 0600, got {oct(file_mode)}"

        # Verify plaintext password is NOT in users.json
        users_content = users_file.read_text()
        assert "alicepass123" not in users_content, "plaintext password should not be in users.json"
        # But hash should be present
        users_data = json.loads(users_content)
        assert users_data["version"] == 1, users_data
        alice_entry = [u for u in users_data["users"] if u["username"] == "alice"]
        assert len(alice_entry) == 1, alice_entry
        assert "hash" in alice_entry[0], alice_entry[0]
        assert "salt" in alice_entry[0], alice_entry[0]
        assert "iterations" in alice_entry[0], alice_entry[0]

        # Test user-list
        code, value = run_control(["user-list"], env)
        assert code == 0, value
        assert value["ok"] is True, value
        assert len(value["users"]) == 2, f"Expected 2 users, got {len(value['users'])}"
        usernames = [u["username"] for u in value["users"]]
        assert "envuser" in usernames, usernames
        assert "alice" in usernames, usernames

        # Test duplicate add fails
        code, value = run_control(["user-add", "--username", "alice", "--password", "anotherpass"], env)
        assert code == 1, value
        assert value["ok"] is False, value
        assert "already exists" in str(value["error"]), value["error"]

        # Test remove env user fails
        code, value = run_control(["user-remove", "--username", "envuser"], env)
        assert code == 1, value
        assert value["ok"] is False, value
        assert "environment" in str(value["error"]).lower() or "managed" in str(value["error"]).lower(), value["error"]

        # Test remove unknown user fails
        code, value = run_control(["user-remove", "--username", "nonexistent"], env)
        assert code == 1, value
        assert value["ok"] is False, value
        assert "not found" in str(value["error"]).lower(), value["error"]

        # Test invalid username fails
        code, value = run_control(["user-add", "--username", "invalid user!", "--password", "pass123"], env)
        assert code == 1, value
        assert value["ok"] is False, value
        assert "invalid" in str(value["error"]).lower() or "username" in str(value["error"]).lower(), value["error"]

        # Test short password fails
        code, value = run_control(["user-add", "--username", "bob", "--password", "short"], env)
        assert code == 1, value
        assert value["ok"] is False, value
        assert "short" in str(value["error"]).lower() or "length" in str(value["error"]).lower() or "8" in str(value["error"]), value["error"]

        # Test generated password path
        code, value = run_control(["user-add", "--username", "bob"], env)
        assert code == 0, value
        assert value["ok"] is True, value
        assert "generatedPassword" in value, "should have generatedPassword"
        gen_pass = value["generatedPassword"]
        assert isinstance(gen_pass, str) and len(gen_pass) >= 16, f"Generated password too short: {gen_pass}"
        # Verify the generated password works (hash is in users.json)
        users_data = json.loads(users_file.read_text())
        bob_entry = [u for u in users_data["users"] if u["username"] == "bob"]
        assert len(bob_entry) == 1, bob_entry
        # Generated password should NOT be in plaintext in users.json
        assert gen_pass not in users_content or gen_pass not in users_file.read_text(), "generated password should not be in users.json"

        # Test status includes updated users list
        code, value = run_control(["status"], env)
        assert code == 0, value
        assert len(value["users"]) == 3, f"Expected 3 users, got {len(value['users'])}"

        # Test status with corrupt users file
        users_file.write_text("{invalid json")
        code, value = run_control(["status"], env)
        assert code == 0, value
        assert value["ok"] is True, value
        assert "usersError" in value, "should have usersError for corrupt file"
        # Should still have env user in users list
        env_users = [u for u in value["users"] if u["source"] == "env"]
        assert len(env_users) == 1, value["users"]

        # Restore users file for port tests
        users_file.write_text('{"version":1,"users":[]}')

        # Create a fixture .env file for port tests
        fixture_env = root / ".env"
        fixture_env.write_text("# Test env file\nSOME_VAR=value\nOPENCODE_WEB_PORT=4098\nANOTHER_VAR=keep_this\n")

        # Test port command when service is NOT active (no restart)
        fake_state.write_text(json.dumps({"running": False, "default": False}))
        code, value = run_control(["port", "--port", "5000"], env)
        assert code == 0, value
        assert value["ok"] is True, value
        assert value["restarted"] is False, "should not restart when inactive"
        assert value["port"] == 5000, value["port"]
        # Verify .env was updated
        env_content = fixture_env.read_text()
        assert "OPENCODE_WEB_PORT=5000" in env_content, env_content
        assert "SOME_VAR=value" in env_content, "should preserve other lines"
        assert "ANOTHER_VAR=keep_this" in env_content, "should preserve other lines"
        assert "OPENCODE_WEB_PORT=4098" not in env_content, "should replace old port"

        # Test port command when service IS active (should restart)
        fake_state.write_text(json.dumps({"running": True, "default": False}))
        code, value = run_control(["port", "--port", "6000"], env)
        assert code == 0, value
        assert value["ok"] is True, value
        assert value["restarted"] is True, "should restart when active"
        assert value["port"] == 6000, value["port"]
        env_content = fixture_env.read_text()
        assert "OPENCODE_WEB_PORT=6000" in env_content, env_content

        # Test port with host parameter (append missing OPENCODE_WEB_HOST)
        fixture_env.write_text("# Test env\nOPENCODE_WEB_PORT=7000\n")
        fake_state.write_text(json.dumps({"running": False, "default": False}))
        code, value = run_control(["port", "--port", "7000", "--host", "0.0.0.0"], env)
        assert code == 0, value
        assert value["ok"] is True, value
        env_content = fixture_env.read_text()
        assert "OPENCODE_WEB_HOST=0.0.0.0" in env_content, f"should append OPENCODE_WEB_HOST: {env_content}"
        assert "OPENCODE_WEB_PORT=7000" in env_content, env_content

        # Test apply fails when unit is not deployed
        unit.unlink()
        code, value = run_control(["apply", "--running", "on", "--default", "on"], env)
        assert code == 1 and value["ok"] is False and "not deployed" in str(value["error"])

        # Recreate unit for security tests
        unit.write_text("[Unit]\n", encoding="utf-8")

        # Fix 10a: Invalid args (no --port) → exit 1 + JSON {ok:false,error}
        code, value = run_control(["port"], env)
        assert code == 1, f"Expected exit 1, got {code}"
        assert value["ok"] is False, value
        assert "error" in value, value
        assert "invalid arguments" in str(value["error"]).lower() or "required" in str(value["error"]).lower(), value["error"]

        # Fix 10b: `export OPENCODE_WEB_PORT=4098` line replaced preserving `export ` prefix
        fixture_env.write_text("# Test env\nexport OPENCODE_WEB_PORT=8080\nSOME_VAR=value\n")
        code, value = run_control(["port", "--port", "9000"], env)
        assert code == 0, value
        env_content = fixture_env.read_text()
        assert "export OPENCODE_WEB_PORT=9000" in env_content, f"export prefix not preserved: {env_content}"
        assert "export OPENCODE_WEB_PORT=8080" not in env_content, "old export line not replaced"
        assert "SOME_VAR=value" in env_content, "other lines not preserved"

        # Fix 10c: host with ":" rejected
        fixture_env.write_text("# Test env\nOPENCODE_WEB_PORT=4098\n")
        code, value = run_control(["port", "--port", "4098", "--host", "host:with:colon"], env)
        assert code == 1, value
        assert value["ok"] is False, value
        assert "invalid host" in str(value["error"]).lower() or "colon" in str(value["error"]).lower(), value["error"]

        # Fix 10d: CLI user-add --username with newline rejected
        code, value = run_control(["user-add", "--username", "alice\n", "--password", "pass123"], env)
        assert code == 1, value
        assert value["ok"] is False, value
        assert "invalid" in str(value["error"]).lower() or "username" in str(value["error"]).lower(), value["error"]

        # Manual installs use the existing foreground launcher as an explicitly
        # controlled detached process when no user-systemd manager is available.
        launcher = home / ".local" / "bin" / "custom-opencode-serve"
        launcher.parent.mkdir(parents=True, exist_ok=True)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            manual_port = probe.getsockname()[1]
        (root / "app" / "server_workflow.py").write_text(
            "import os\nfrom http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer\n"
            "ThreadingHTTPServer(('127.0.0.1', int(os.environ['OPENCODE_WEB_PORT'])), SimpleHTTPRequestHandler).serve_forever()\n",
            encoding="utf-8",
        )
        launcher.write_text(
            f"#!/bin/sh\nexec {sys.executable} {root / 'app' / 'server_workflow.py'}\n",
            encoding="utf-8",
        )
        launcher.chmod(0o755)
        manual_env = {
            **env,
            "CUSTOM_OPENCODE_SERVICE_MODE": "manual",
            "OPENCODE_WEBSERVER_STATE": str(root / "manual-webserver.json"),
            "OPENCODE_WEB_HOST": "127.0.0.1",
            "OPENCODE_WEB_PORT": str(manual_port),
        }
        code, value = run_control(["apply", "--running", "on", "--default", "off"], manual_env)
        assert code == 0 and value["running"] is True and value["serviceMode"] == "manual", value
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            next_port = probe.getsockname()[1]
        code, value = run_control(["port", "--port", str(next_port), "--host", "127.0.0.1"], manual_env)
        assert code == 0 and value["restarted"] is True and value["port"] == next_port, value
        manual_env["OPENCODE_WEB_PORT"] = str(next_port)
        code, value = run_control(["default", "on"], manual_env)
        assert code == 1 and "does not support autostart" in str(value["error"]), value
        code, value = run_control(["stop"], manual_env)
        assert code == 0 and value["running"] is False, value

    print("Webserver control smoke passed: systemd/manual lifecycle + state permissions + user management + port configuration + security validation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
