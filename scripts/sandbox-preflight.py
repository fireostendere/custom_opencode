#!/usr/bin/env python3
"""Report unsupported kernel isolation as BLOCKED_ENV (77), never PASS."""
import json
import shutil
import subprocess
import sys

binary = shutil.which("bwrap")
if not binary:
    print(json.dumps({"status": "BLOCKED_ENV", "reason": "bubblewrap is not installed"}))
    sys.exit(77)
command = [
    binary,
    "--unshare-all",
    "--die-with-parent",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--",
    "/bin/true",
]
try:
    result = subprocess.run(command, capture_output=True, text=True, timeout=10, check=False)
except (OSError, subprocess.TimeoutExpired) as error:
    print(json.dumps({"status": "BLOCKED_ENV", "reason": str(error)}))
    sys.exit(77)
status = "PASS" if result.returncode == 0 else "BLOCKED_ENV"
print(
    json.dumps(
        {"status": status, "exitCode": result.returncode, "diagnostic": result.stderr[-3000:]}
    )
)
sys.exit(0 if result.returncode == 0 else 77)
