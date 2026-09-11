#!/usr/bin/env python3
"""Install with real dependencies into a disposable HOME and test native APIs/TUI.

Uses normal install.sh with both post-install gates enabled. Provider endpoints
point to a closed loopback port, RAG/DipTrace are disabled, and no inference is
requested. Optional dependency seeds support network-isolated audit machines.
"""
from __future__ import annotations
import argparse
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--cli-prefix", type=Path, help="Optional already downloaded genuine npm CLI prefix"
    )
    parser.add_argument(
        "--ponytail-url", help="Optional genuine upstream Git bundle/URL for offline installation"
    )
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {
        "ok": False,
        "serviceMode": "manual",
        "dependencySeed": bool(args.cli_prefix),
        "checks": [],
    }
    with tempfile.TemporaryDirectory(prefix="custom-opencode-native-") as temporary:
        home, checkout = Path(temporary) / "home", Path(temporary) / "checkout"
        home.mkdir()
        (home / ".custom-opencode-audit-home").touch()
        shutil.copytree(
            ROOT,
            checkout,
            ignore=shutil.ignore_patterns(
                ".git", ".env", "__pycache__", "node_modules", ".tmp_verify"
            ),
        )
        if args.cli_prefix:
            shutil.copytree(
                args.cli_prefix.resolve(), home / ".local", symlinks=True, dirs_exist_ok=True
            )
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            backend_port = probe.getsockname()[1]
            while backend_port == port:
                probe.close()
                probe = socket.socket()
                probe.bind(("127.0.0.1", 0))
                backend_port = probe.getsockname()[1]
        config = home / ".config/opencode"
        config.mkdir(parents=True, mode=0o700)
        # Native service otherwise has a fixed default port shared by all HOMEs.
        (config / "service.json").write_text(json.dumps({"port": backend_port}) + "\n")
        (config / "service.json").chmod(0o600)
        values = {
            "CUSTOM_OPENCODE_SERVICE_MODE": "manual",
            "CUSTOM_OPENCODE_INSTALL_SELFTEST": "1",
            "OPENCODE_SERVER_USERNAME": "audit",
            "OPENCODE_SERVER_PASSWORD": secrets.token_urlsafe(24),
            "OPENCODE_WEB_HOST": "127.0.0.1",
            "OPENCODE_WEB_PORT": str(port),
            "OPENCODE_POLICY_PORT": str(
                port + 1 if port < 65535 and port + 1 != backend_port else port - 1
            ),
            "OPENCODE_SCRATCH_DIRECTORY": str(home / "scratch"),
            "OPENCODE_PROJECT_ROOTS": str(home),
            "OPENCODE_CONFIG_DIR": str(home / ".config/opencode"),
            "OPENCODE_AUTH_ALLOW_BASIC": "0",
            "MCP_RAG_ENABLED": "0",
            "DIPTRACE_MCP_ENABLED": "0",
            "PONYTAIL_ENABLED": "1",
            "TOKEN_PLAN_API_KEY": "fixture-zero-inference",
            "TOKEN_PLAN_ANTHROPIC_BASE_URL": "http://127.0.0.1:1/anthropic/v1",
            "TOKEN_PLAN_OPENAI_BASE_URL": "http://127.0.0.1:1/compatible-mode/v1",
            "OPENCODE_OPENAI_ACCESS": "",
            "OPENCODE_OPENAI_REFRESH": "",
            "OPENCODE_OPENAI_ACCOUNT_ID": "",
            "OPENCODE_ZEN_KEY": "",
            "OPENCODE_GO_KEY": "",
            "GEMINI_API_KEY": "",
            "GOOGLE_API_KEY": "",
        }
        if args.ponytail_url:
            values["PONYTAIL_UPSTREAM_URL"] = args.ponytail_url
        text = (checkout / ".env.example").read_text()
        for key, value in values.items():
            line = key + "=" + shlex.quote(value)
            if re.search("^" + key + "=", text, re.M):
                text = re.sub("^" + key + "=.*$", lambda _: line, text, flags=re.M)
            else:
                text += "\n" + line + "\n"
        (checkout / ".env").write_text(text)
        (checkout / ".env").chmod(0o600)
        env = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith(
                (
                    "OPENCODE_",
                    "CUSTOM_OPENCODE_",
                    "TOKEN_PLAN_",
                    "MCP_",
                    "PONYTAIL_",
                    "OPENAI_",
                    "GEMINI_",
                    "GOOGLE_",
                    "DIPTRACE_",
                )
            )
        }
        env.update(
            HOME=str(home),
            XDG_CONFIG_HOME=str(home / ".config"),
            XDG_DATA_HOME=str(home / ".local/share"),
            XDG_STATE_HOME=str(home / ".local/state"),
            XDG_CACHE_HOME=str(home / ".cache"),
            PATH=str(home / ".local/bin") + os.pathsep + env.get("PATH", ""),
            PYTHONUNBUFFERED="1",
            # The strip above drops OPENCODE_*; keep the CLI's own updater detached from
            # any bare invocation so it cannot rewrite the tree under test mid-run.
            OPENCODE_DISABLE_AUTOUPDATE="1",
        )

        def run(name, command, timeout=600):
            with (output / (name + ".log")).open("w") as log:
                process = subprocess.Popen(
                    command,
                    cwd=checkout,
                    env=env,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                try:
                    code = process.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
                    code = 124
            report["checks"].append({"name": name, "exitCode": code, "ok": code == 0})
            print(f"{name}: " + ("PASS" if code == 0 else f"FAIL ({code})"), flush=True)
            if code:
                raise RuntimeError(f"{name} failed; see retained log")

        server = None
        try:
            run("install", ["bash", "scripts/install.sh"])
            with (output / "foreground.log").open("w") as log:
                server = subprocess.Popen(
                    [str(home / ".local/bin/custom-opencode-serve")],
                    cwd=home / "scratch",
                    env=env,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
            for _ in range(80):
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                try:
                    connection.request("GET", "/")
                    if connection.getresponse().status in {200, 302}:
                        break
                except OSError:
                    time.sleep(0.25)
                finally:
                    connection.close()
            else:
                raise RuntimeError("Installed foreground server did not become ready")
            run(
                "native-runtime",
                [
                    "node",
                    "scripts/native-runtime-smoke.mjs",
                    "--home",
                    str(home),
                    "--output",
                    str(output / "native-runtime.json"),
                ],
                120,
            )
            run(
                "native-tui",
                [
                    "python3",
                    "scripts/native-tui-smoke.py",
                    "--home",
                    str(home),
                    "--output",
                    str(output / "native-tui.json"),
                ],
                120,
            )
            report["ok"] = True
        except Exception as error:
            report["error"] = str(error)
            backend_log = home / ".local/share/opencode/log/opencode.log"
            if backend_log.is_file():
                shutil.copy2(backend_log, output / "backend-failure.log")
        finally:
            if server is not None and server.poll() is None:
                os.killpg(server.pid, signal.SIGTERM)
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(server.pid, signal.SIGKILL)
                    server.wait()
            policy_env = {**env, **values}
            policy = home / ".local/bin/custom-opencode-policy"
            if policy.is_file():
                subprocess.run(
                    [str(policy), "stop"],
                    env=policy_env,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=15,
                    check=False,
                )
            binary = shutil.which("opencode2", path=env["PATH"])
            if binary:
                subprocess.run(
                    [binary, "service", "stop"],
                    env=env,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=15,
                    check=False,
                )
            (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
