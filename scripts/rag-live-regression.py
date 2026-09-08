#!/usr/bin/env python3
"""Live zero-LLM-token OpenCode <-> mcp-rag regression.

This test is intentionally host-level rather than GitHub-CI-level: it requires
the configured mcp-rag checkout, its local corpus/index and Qdrant. It performs
no ingestion and no model inference.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))


def _contract_validator():
    spec = importlib.util.spec_from_file_location("rag_probe", ROOT / "scripts" / "rag-probe.py")
    if not spec or not spec.loader:
        raise ImportError("cannot load rag-probe contract validator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.validate_probe_contract


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--query", default="DipTrace PCB layout")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    try:
        import server_rag
    except BaseException as exc:
        print(f"server_rag import failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    runtime = server_rag.plus._rag_runtime()
    if not runtime.get("available"):
        print("RAG runtime unavailable: set MCP_RAG_ROOT/MCP_RAG_BIN", file=sys.stderr)
        return 2

    # Full mode is model-free: readiness first, then one local retrieval smoke,
    # then dynamic kb MCP connect and required-tool protocol verification.
    result = server_rag.run_rag_start("full")
    if not result.get("ok"):
        if args.json:
            print(json.dumps({"ok": False, "stage": "rag-start", "result": result}, ensure_ascii=False))
        else:
            print("RAG full lifecycle failed:", json.dumps(result, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1

    probe = server_rag.plus._run_rag_probe("search", args.query)
    required = {
        "knowledge_search", "knowledge_get", "knowledge_sources", "knowledge_status",
        "knowledge_research", "knowledge_figures", "knowledge_get_figure",
        "knowledge_get_part_evidence",
    }
    tools = set(probe.get("tools") or []) if isinstance(probe, dict) else set()
    raw_search = probe.get("search") if isinstance(probe, dict) else None
    contract = _contract_validator()(raw_search, probe.get("get"), probe.get("continuation"), require_get=True)
    hits = raw_search.get("hits") if isinstance(raw_search, dict) else None
    ok = bool(
        probe.get("ok") and probe.get("requiredToolsPresent") and required.issubset(tools)
        and not probe.get("contractErrors") and contract["ok"]
        and probe.get("searchChecks") and probe.get("getChecks")
    )

    output = {
        "ok": ok,
        "zeroLlmTokens": True,
        "query": args.query,
        "runtime": result.get("runtime"),
        "mcp": result.get("mcp"),
        "protocol": result.get("protocol"),
        "search": raw_search,
        "searchHitCount": len(hits) if isinstance(hits, list) else 0,
        "contractErrors": probe.get("contractErrors") if isinstance(probe, dict) else ["invalid probe response"],
        "localContractErrors": contract["contractErrors"],
        "searchChecks": probe.get("searchChecks") if isinstance(probe, dict) else False,
        "getChecks": probe.get("getChecks") if isinstance(probe, dict) else False,
        "continuationState": probe.get("continuationState") if isinstance(probe, dict) else "invalid probe response",
        "tools": sorted(tools),
        "requiredTools": sorted(required),
    }
    if args.json:
        print(json.dumps(output, ensure_ascii=False, separators=(",", ":"), default=str))
    else:
        print(json.dumps(output, ensure_ascii=False, indent=2, default=str))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
