#!/usr/bin/env python3
"""Non-destructive merge preflight for frontend + Runtime V3 + mcp-rag wiring."""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import re
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def _read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def _check_file(relative: str, markers: tuple[str, ...], errors: list[str]) -> None:
    path = ROOT / relative
    if not path.is_file():
        errors.append(f"missing: {relative}")
        return
    text = path.read_text(encoding="utf-8")
    for marker in markers:
        if marker not in text:
            errors.append(f"{relative}: missing marker {marker!r}")


def _load_contract(errors: list[str]) -> dict[str, Any]:
    path = ROOT / "app/integration_contract.py"
    spec = importlib.util.spec_from_file_location("custom_opencode_integration_contract", path)
    if spec is None or spec.loader is None:
        errors.append("unable to load app/integration_contract.py")
        return {}
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    value = module.contract()
    if not isinstance(value, dict):
        errors.append("integration contract must be an object")
        return {}
    return value


def run() -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []

    _check_file(
        "app/server_workflow.py",
        ("import integration_contract", 'parsed.path == "/client-integration.json"', "runtime_v3.install"),
        errors,
    )
    _check_file(
        "app/server_rag.py",
        (
            "knowledge_search",
            "knowledge_get",
            "knowledge_sources",
            "knowledge_status",
            'runtime, ["--wait", "20"]',
            'runtime,\n        ["--no-start", "--search", RAG_QUERY]',
        ),
        errors,
    )
    _check_file(
        "scripts/rag-mcp.sh",
        ("MCP_RAG_ROOT", "MCP_RAG_BIN", '"$ROOT/../mcp-rag"'),
        errors,
    )
    _check_file(
        ".env.example",
        ("MCP_RAG_ENABLED=auto", "MCP_RAG_ROOT=", "MCP_RAG_BIN="),
        errors,
    )
    _check_file(
        "app/ux-controls.js",
        (
            "composerActionState",
            "action.kind === 'queue'",
            "action.kind === 'stop'",
            "function currentMode() {\n  return modeFromAgent(rawActiveAgent())",
            "dataset.modelProfile",
        ),
        errors,
    )
    _check_file(
        "app/access-fix.js",
        (
            "resolvedPermissions",
            "installPermissionScope",
        ),
        errors,
    )
    _check_file(
        "app/access-fix.css",
        ("#agentControls", "display:none!important", "grid-template-columns:minmax(0,1.4fr) minmax(128px,.8fr)"),
        errors,
    )
    _check_file(
        "app/server_runtime.py",
        (
            "/client-task-create.json",
            "/client-task-control.json",
            "/client-model-capabilities.json",
            "/client-resource-status.json",
            "/client-plan.json",
            "latest_plan_document",
            "ResourceScheduler",
            "recover_inflight",
        ),
        errors,
    )
    _check_file(
        "app/model_registry.py",
        ("qwen3.8-orchestrated", "ROLE_DEFAULTS", "role_models", "validate_provider_ref"),
        errors,
    )
    _check_file(
        "app/runtime_v3.py",
        (
            "/client-runtime-v3.json",
            "/client-runtime-events.json",
            "SharedRAGService",
            "DynamicContextManager",
            "ScopedSecretBroker",
            "SandboxManager",
        ),
        errors,
    )

    launcher = _read("scripts/rag-mcp.sh") if (ROOT / "scripts/rag-mcp.sh").is_file() else ""
    if re.search(r"/(?:home|Users)/[^/\s'\"]+/[^\n]*mcp-rag", launcher):
        errors.append("scripts/rag-mcp.sh contains a user-specific absolute mcp-rag path")

    contract = _load_contract(errors)
    required_routes = {
        "managedSend",
        "taskList",
        "taskCreate",
        "taskControl",
        "runtime",
        "nativePlan",
        "mcpGateway",
        "ragStart",
    }
    routes = contract.get("routes") if isinstance(contract.get("routes"), dict) else {}
    missing_routes = sorted(required_routes - set(routes))
    if missing_routes:
        errors.append("integration contract missing routes: " + ", ".join(missing_routes))

    frontend = contract.get("frontend") if isinstance(contract.get("frontend"), dict) else {}
    modes = [str(item) for item in (frontend.get("modes") or [])]
    if modes != ["build", "plan"]:
        errors.append("integration contract frontend modes must expose Build and Plan")
    if frontend.get("modeSelectorVisible") is not True:
        errors.append("integration contract must expose the execution mode selector")
    if frontend.get("legacyPlanCompatibility") is not True:
        errors.append("integration contract must preserve native plan compatibility")
    if frontend.get("planVisibleDuringBuild") is not True:
        errors.append("integration contract must expose native plans during Build")
    if frontend.get("orchestrationLivesInModelProfile") is not True:
        errors.append("integration contract must keep orchestration in the model profile")
    if frontend.get("modelProfiles") != ["direct", "qwen3.8-orchestrated", "gpt-5.6-sol-orchestrated"]:
        errors.append("integration contract model profiles must match direct and orchestrated aliases")

    required_tools = {"knowledge_search", "knowledge_get", "knowledge_sources", "knowledge_status"}
    rag = contract.get("rag") if isinstance(contract.get("rag"), dict) else {}
    tools = {str(item) for item in (rag.get("requiredTools") or [])}
    if tools != required_tools:
        errors.append("integration contract RAG tool set does not match server gate")

    prep = ROOT / "docs/integration-prep-20260829.md"
    if not prep.is_file():
        warnings.append("missing integration handoff documentation")

    return {
        "ok": not errors,
        "root": str(ROOT),
        "errors": errors,
        "warnings": warnings,
        "contractVersion": contract.get("apiVersion"),
        "runtimeVersion": contract.get("runtimeVersion"),
        "checks": {
            "frontendContract": not any("contract" in error for error in errors),
            "ragPortableLauncher": not any("rag-mcp.sh" in error for error in errors),
            "ragNonDestructiveLifecycle": not any("server_rag.py" in error for error in errors),
            "runtimeV3": not any("runtime_v3.py" in error for error in errors),
            "durableServerTasks": not any("server_runtime.py" in error for error in errors),
            "uxContract": not any(
                marker in error
                for error in errors
                for marker in ("ux-controls.js", "access-fix.js", "access-fix.css", "frontend modes", "mode selector")
            ),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON")
    args = parser.parse_args()
    report = run()
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print("frontend/RAG integration preflight:", "PASS" if report["ok"] else "FAIL")
        for key, value in report["checks"].items():
            print(f"  {key}: {'PASS' if value else 'FAIL'}")
        for warning in report["warnings"]:
            print(f"  warning: {warning}")
        for error in report["errors"]:
            print(f"  error: {error}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
