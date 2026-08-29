#!/usr/bin/env python3
"""Post-install health check for custom_opencode.

No LLM inference is performed. When RAG is configured, the check may start the
local loopback Qdrant service and connect the kb MCP server via the same bounded
quick lifecycle used by /rag-start quick.
"""
from __future__ import annotations

import argparse
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="custom_opencode install self-test")
    parser.add_argument("--rag-enabled", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    checks: list[dict[str, Any]] = []
    started = time.monotonic()

    def add(name: str, ok: bool, detail: str, *, required: bool = True) -> None:
        checks.append({
            "name": name,
            "ok": bool(ok),
            "required": required,
            "detail": detail,
        })

    try:
        active = subprocess.run(
            ["systemctl", "--user", "is-active", "opencode-web-client.service"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=10,
            check=False,
        )
        state = (active.stdout or active.stderr or "unknown").strip()
        add("web-service", active.returncode == 0 and state == "active", state)
    except (OSError, subprocess.TimeoutExpired) as exc:
        add("web-service", False, f"{type(exc).__name__}: {exc}")

    try:
        import server_rag
    except BaseException as exc:  # includes SystemExit from invalid/missing runtime config
        add("server-import", False, f"{type(exc).__name__}: {exc}")
        return emit(checks, started, args.json)

    base = server_rag.plus.ext.base
    plus = server_rag.plus
    add("server-import", True, "RAG-aware web server imports successfully")

    try:
        config, path = plus._read_runtime_config()
        add(
            "runtime-config",
            isinstance(config, dict),
            path if isinstance(config, dict) else f"Unreadable runtime config: {path}",
        )
    except Exception as exc:
        add("runtime-config", False, f"{type(exc).__name__}: {exc}")

    try:
        target = server_rag._v2_workspace_target("/api/model", str(base.SCRATCH_ROOT))
        models = plus._backend_request_json("GET", target, timeout=15.0)
        add("opencode-backend", models is not None, f"HTTP API reachable at {base.BACKEND_URL}")
    except Exception as exc:
        add("opencode-backend", False, f"{type(exc).__name__}: {exc}")

    try:
        host = str(base.WEB_HOST)
        if host in {"0.0.0.0", "::", "[::]"}:
            host = "127.0.0.1"
        connection = http.client.HTTPConnection(host, int(base.WEB_PORT), timeout=8)
        try:
            connection.request("GET", "/", headers={"Authorization": base.CLIENT_AUTH})
            response = connection.getresponse()
            body = response.read(64 * 1024)
            ok = response.status == 200 and b"OpenCode" in body
            add("web-http", ok, f"HTTP {response.status} on {host}:{base.WEB_PORT}")
        finally:
            connection.close()
    except Exception as exc:
        add("web-http", False, f"{type(exc).__name__}: {exc}")

    if args.rag_enabled:
        try:
            result = server_rag.run_rag_start("quick")
            registry = ((result.get("runtime") or {}).get("registry") or {}) if isinstance(result, dict) else {}
            docs = registry.get("documents")
            chunks = registry.get("chunks")
            mcp = (result.get("mcp") or {}).get("action") if isinstance(result, dict) else None
            detail = f"{docs or 0} docs · {chunks or 0} chunks · MCP {mcp or 'unknown'}"
            if not result.get("ok"):
                detail = str(
                    result.get("error")
                    or (result.get("runtime") or {}).get("error")
                    or (result.get("mcp") or {}).get("error")
                    or result.get("stage")
                    or detail
                )
            add("rag-quick", bool(result.get("ok")), detail)
        except Exception as exc:
            add("rag-quick", False, f"{type(exc).__name__}: {exc}")
    else:
        add("rag-quick", True, "RAG not configured; skipped", required=False)

    return emit(checks, started, args.json)


def emit(checks: list[dict[str, Any]], started: float, json_mode: bool) -> int:
    failed = [item for item in checks if item["required"] and not item["ok"]]
    report = {
        "ok": not failed,
        "zeroLlmTokens": True,
        "elapsedMs": int((time.monotonic() - started) * 1000),
        "checks": checks,
    }
    if json_mode:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print("==> Post-install self-test")
        for item in checks:
            mark = "PASS" if item["ok"] else ("SKIP" if not item["required"] else "FAIL")
            print(f"[{mark}] {item['name']}: {item['detail']}")
        print("Self-test PASS" if report["ok"] else "Self-test FAILED")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
