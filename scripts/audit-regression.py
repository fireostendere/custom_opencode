#!/usr/bin/env python3
"""Run the reproducible, model-free audit matrix and retain every suite result.

Live providers, real RAG/DipTrace, kernel sandboxing and real service deployment
are deliberately separate acceptance gates, never silently counted as passes.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
SUITES = [
    ("audit-model-context", [sys.executable, "scripts/audit-fixes-regression.py"]),
    ("audit-mcp-payload", ["node", "scripts/audit-fixes-regression.mjs"]),
    ("execution-ledger", [sys.executable, "scripts/execution-ledger-regression.py"]),
    ("request-budget-protocol", ["node", "scripts/request-budget-regression.mjs"]),
    ("tool-fabric-contracts", [sys.executable, "scripts/tool-fabric-smoke.py", "--contracts-only"]),
    ("core", ["bash", "scripts/verify.sh"]),
    ("runtime-v3", ["bash", "scripts/verify-runtime-v3.sh"]),
    ("routing-effort", [sys.executable, "scripts/model-routing-effort-smoke.py"]),
    ("install-update-fixtures", ["bash", "scripts/install-regression.sh"]),
    ("bootstrap", ["bash", "scripts/bootstrap-regression.sh"]),
    ("ponytail", ["bash", "scripts/ponytail-provision-regression.sh"]),
    ("composed-server", [sys.executable, "scripts/web-server-smoke.py"]),
    ("web-security", [sys.executable, "scripts/web-security-smoke.py"]),
    ("runtime-invariants", [sys.executable, "scripts/runtime-invariants-smoke.py"]),
    ("queue-reconciliation", [sys.executable, "scripts/runtime-queue-reconcile-smoke.py"]),
    ("tui-panels", ["node", "scripts/tui-regression.mjs"]),
    ("tui-clipboard", ["node", "scripts/tui-clipboard-regression.mjs"]),
    ("panel-submit", ["node", "scripts/panel-submit-regression.mjs"]),
    ("stream-render", ["node", "scripts/stream-render-smoke.mjs"]),
    ("queue-badges-browser", [sys.executable, "scripts/queue-badge-convergence.py"]),
    ("web-fixtures-browser", [sys.executable, "scripts/web-fixture-e2e.py"]),
    ("web-production-frontend", [sys.executable, "scripts/local-web-harness.py", "test"]),
    ("web-critical-controls", [sys.executable, "scripts/web-critical-controls-e2e.py"]),
    ("packaged-tui-pty", ["bash", "scripts/tui-package-smoke.sh"]),
    ("integration-contract", [sys.executable, "scripts/integration-preflight.py"]),
    ("workflow-cli-consistency", [sys.executable, "scripts/workflow-cli-consistency.py"]),
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--suite", action="append", choices=[name for name, _ in SUITES])
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()
    if args.timeout < 1:
        parser.error("--timeout must be positive")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    # Resolve the real browser cache before replacing HOME/XDG for each suite.
    # Isolation must not hide the browser installed by the calling CI job.
    browser_cache = os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or str(
        (
            Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "ms-playwright"
        ).resolve()
    )
    rows = []
    report = {
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "suites": rows,
        "externalGates": [
            "paid provider inference",
            "live RAG corpus",
            "live DipTrace",
            "kernel sandbox execution",
            "real install/service supervision",
        ],
    }
    for name, command in SUITES:
        if args.suite and name not in args.suite:
            continue
        with tempfile.TemporaryDirectory(prefix="opencode-audit-") as temporary:
            env = {
                k: v
                for k, v in os.environ.items()
                if not k.startswith(
                    (
                        "OPENCODE_",
                        "CUSTOM_OPENCODE_",
                        "TOKEN_PLAN_",
                        "MCP_RAG_",
                        "DIPTRACE_MCP_",
                        "GEMINI_",
                        "GOOGLE_",
                    )
                )
            }
            env.update(
                HOME=temporary,
                XDG_CONFIG_HOME=temporary + "/.config",
                XDG_DATA_HOME=temporary + "/.local/share",
                XDG_STATE_HOME=temporary + "/.local/state",
                XDG_CACHE_HOME=temporary + "/.cache",
                PYTHONUNBUFFERED="1",
                PLAYWRIGHT_BROWSERS_PATH=browser_cache,
            )
            if os.environ.get("OPENCODE2_BIN"):
                env["OPENCODE2_BIN"] = os.environ["OPENCODE2_BIN"]
            # Safety valve, not harness contamination: keep the pinned CLI's own updater
            # detached from any bare invocation inside suites (the OPENCODE_* strip above
            # would otherwise drop the workflow-level gate).
            env["OPENCODE_DISABLE_AUTOUPDATE"] = "1"
            started = time.monotonic()
            with (output / f"{name}.log").open("w") as log:
                process = subprocess.Popen(
                    command,
                    cwd=ROOT,
                    env=env,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                try:
                    code = process.wait(timeout=args.timeout)
                    status = "PASS" if code == 0 else "FAIL"
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
                    code, status = 124, "TIMEOUT"
            row = {
                "name": name,
                "status": status,
                "exitCode": code,
                "seconds": round(time.monotonic() - started, 3),
                "log": f"{name}.log",
                "command": command,
            }
            rows.append(row)
            report["ok"] = all(row["status"] == "PASS" for row in rows)
            temporary_report = output / "report.json.tmp"
            temporary_report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            temporary_report.replace(output / "report.json")
            print(f"{status:7} {name} ({row['seconds']}s)", flush=True)
    return 0 if report.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
