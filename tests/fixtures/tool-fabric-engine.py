"""Deterministic subprocess for broker regressions; no physical/network access."""
import json
import errno
import os
from pathlib import Path
import sys
import time
import socket

mode, output = sys.argv[1:3]
if mode == "sleep":
    time.sleep(60)
elif mode == "fail":
    print("fixture failure", file=sys.stderr)
    sys.exit(7)
elif mode == "flood":
    os.write(1, b"x" * 100_000 + b"\xff")
    os.write(2, b"e" * 100_000)
elif mode == "sandbox":
    report = {"outsideReadable": Path(sys.argv[3]).exists()}
    try:
        Path("should-not-write").write_text("bad")
        report["sourceWritable"] = True
    except OSError as exc:
        if exc.errno not in {errno.EACCES, errno.EROFS}:
            raise
        report["sourceWritable"] = False
    try:
        with socket.create_connection(("127.0.0.1", int(sys.argv[4])), timeout=.2):
            report["hostNetworkAccessible"] = True
    except OSError:
        report["hostNetworkAccessible"] = False
    Path(output, "escape-link").symlink_to("/etc/passwd")
    Path(output, "sandbox.json").write_text(json.dumps(report))
    print(json.dumps(report))
else:
    Path(output, "result.json").write_text(json.dumps({"answer": 42}))
    print(json.dumps({"args": sys.argv[3:], "secretInherited": "FABRIC_TEST_SECRET" in os.environ}))
