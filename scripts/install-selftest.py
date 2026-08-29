#!/usr/bin/env python3
"""Post-install health check for custom_opencode.

No LLM inference is performed. When RAG is configured, the check may start the
local loopback Qdrant service and connect the kb MCP server via the same bounded
quick lifecycle used by /rag-start quick.
"""
from __future__ import annotations

import argparse
import http.client
import ipaddress
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="custom_opencode install self-test")
    parser.add_argument("--rag-enabled", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser


def retry(check: Callable[[], tuple[bool, str]], timeout: float = 20.0,
          interval: float = 0.5) -> tuple[bool, str]:
    deadline = time.monotonic() + max(0.1, timeout)
    last = (False, "not checked")
    while True:
        try:
            last = check()
        except Exception as exc:
            last = (False, f"{type(exc).__name__}: {exc}")
        if last[0] or time.monotonic() >= deadline:
            return last
        time.sleep(interval)


def local_probe_host(bind_host: str) -> str:
    raw = bind_host.strip("[]")
    try:
        address = ipaddress.ip_address(raw)
        return "localhost" if address.is_unspecified else raw
    except ValueError:
        return bind_host


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

    def service_check() -> tuple[bool, str]:
        active = subprocess.run(
            ["systemctl", "--user", "is-active", "opencode-web-client.service"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=5,
            check=False,
        )
        state = (active.stdout or active.stderr or "unknown").strip()
        return active.returncode == 0 and state == "active", state

    ok, detail = retry(service_check, timeout=15.0)
    add("web-service", ok, detail)

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

    opencode2 = shutil.which("opencode2")
    if opencode2:
        try:
            service_process_env = os.environ.copy()
            service_process_env.pop("OPENCODE_CONFIG_DIR", None)
            persisted = subprocess.run(
                [opencode2, "service", "get", "env"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=10,
                check=False,
                env=service_process_env,
            )
            service_env = json.loads(persisted.stdout) if persisted.returncode == 0 else {}
            configured_dir = os.environ.get("OPENCODE_CONFIG_DIR") or str(
                Path.home() / ".config" / "opencode")
            expected_dir = str(Path(configured_dir).expanduser())
            missing_env = sorted(
                name for name in (
                    "OPENCODE_CONFIG_DIR",
                    "TOKEN_PLAN_API_KEY",
                    "TOKEN_PLAN_ANTHROPIC_BASE_URL",
                )
                if not isinstance(service_env, dict) or not service_env.get(name)
            )
            wrong_dir = isinstance(service_env, dict) and service_env.get("OPENCODE_CONFIG_DIR") != expected_dir
            service_env_ok = not missing_env and not wrong_dir
            if missing_env:
                service_env_detail = "Missing: " + ", ".join(missing_env)
            elif wrong_dir:
                service_env_detail = "OPENCODE_CONFIG_DIR does not match installed profile"
            else:
                service_env_detail = "profile + provider environment persisted"
            add("shared-service-env", service_env_ok, service_env_detail)
        except Exception as exc:
            add("shared-service-env", False, f"{type(exc).__name__}: {exc}")
    else:
        add("shared-service-env", False, "opencode2 not found")

    backend_models: set[str] = set()

    def backend_check() -> tuple[bool, str]:
        target = server_rag._v2_workspace_target("/api/model", str(base.SCRATCH_ROOT))
        models = plus._backend_request_json("GET", target, timeout=5.0)
        backend_models.clear()
        backend_models.update(plus._model_ids(models))
        return models is not None, f"HTTP API reachable at {base.BACKEND_URL}"

    ok, detail = retry(backend_check, timeout=20.0)
    add("opencode-backend", ok, detail)

    required_models = {plus.MAX_MODEL, plus.FLASH_MODEL}
    missing_models = sorted(required_models - backend_models)
    add(
        "backend-model-catalog",
        not missing_models,
        "Max + Flash available" if not missing_models else "Missing: " + ", ".join(missing_models),
    )

    try:
        agents = plus._data(plus._backend_request_json(
            "GET", server_rag._v2_workspace_target("/api/agent", str(base.SCRATCH_ROOT)), timeout=5.0))
        agent_ids = {
            item.get("id") for item in agents or []
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        }
        add(
            "backend-agent-catalog",
            "fast-reader" in agent_ids,
            "fast-reader registered" if "fast-reader" in agent_ids else "fast-reader missing",
        )
    except Exception as exc:
        add("backend-agent-catalog", False, f"{type(exc).__name__}: {exc}")

    try:
        plugins = plus._data(plus._backend_request_json(
            "GET", server_rag._v2_workspace_target("/api/plugin", str(base.SCRATCH_ROOT)), timeout=5.0))
        plugin_status = {
            item.get("id"): item.get("status") for item in plugins or []
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        }
        configured_dir = os.environ.get("OPENCODE_CONFIG_DIR") or str(
            Path.home() / ".config" / "opencode")
        plugin_dir = str(Path(configured_dir).expanduser() / "plugins")
        failed_local_plugins = sorted(
            Path(str((item.get("source") or {}).get("path"))).name
            for item in plugins or []
            if isinstance(item, dict)
            and item.get("status") == "failed"
            and isinstance(item.get("source"), dict)
            and str((item.get("source") or {}).get("path", "")).startswith(plugin_dir + "/")
        )
        required_plugins = {
            "config-backup",
            "keep-awake",
            "lazy-local-router",
            "notify-win",
            "qwen-quota",
            "slow-cmd-watchdog",
        }
        inactive_plugins = sorted(
            plugin_id for plugin_id in required_plugins
            if plugin_status.get(plugin_id) != "active"
        )
        add(
            "backend-plugin-catalog",
            not inactive_plugins and not failed_local_plugins,
            "6 custom plugins active; no failed local plugins"
            if not inactive_plugins and not failed_local_plugins
            else "; ".join(filter(None, [
                "Missing/inactive: " + ", ".join(inactive_plugins) if inactive_plugins else "",
                "Failed local: " + ", ".join(failed_local_plugins) if failed_local_plugins else "",
            ])),
        )
    except Exception as exc:
        add("backend-plugin-catalog", False, f"{type(exc).__name__}: {exc}")

    def web_check() -> tuple[bool, str]:
        host = local_probe_host(str(base.WEB_HOST))
        connection = http.client.HTTPConnection(host, int(base.WEB_PORT), timeout=4)
        try:
            connection.request("GET", "/", headers={"Authorization": base.CLIENT_AUTH})
            response = connection.getresponse()
            body = response.read(64 * 1024)
            return (
                response.status == 200 and b"OpenCode" in body,
                f"HTTP {response.status} on {host}:{base.WEB_PORT}",
            )
        finally:
            connection.close()

    ok, detail = retry(web_check, timeout=20.0)
    add("web-http", ok, detail)

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
