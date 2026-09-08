#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

def _decode_result(result: Any) -> Any:
    structured = getattr(result, "structuredContent", None)
    if structured is not None:
        return structured
    texts: list[str] = []
    for item in getattr(result, "content", []) or []:
        text = getattr(item, "text", None)
        if isinstance(text, str):
            texts.append(text)
    joined = "\n".join(texts).strip()
    if not joined:
        return None
    try:
        return json.loads(joined)
    except json.JSONDecodeError:
        return joined


def _payload(value: Any) -> dict[str, Any] | None:
    """Normalize direct FastMCP dicts and compatibility result wrappers."""
    if not isinstance(value, dict):
        return None
    nested = value.get("result")
    return nested if isinstance(nested, dict) else value


def _absolute_http_url(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def validate_probe_contract(
    search_value: Any,
    get_value: Any = None,
    continuation_value: Any = None,
    *,
    require_get: bool = False,
) -> dict[str, Any]:
    """Validate the model-free search/get evidence contract without MCP access."""
    errors: list[str] = []
    search = _payload(search_value)
    hits = search.get("hits") if search else None
    first_document_id: str | None = None
    if not isinstance(hits, list) or not hits:
        errors.append("search.hits must be a non-empty list")
    else:
        for index, hit in enumerate(hits):
            if not isinstance(hit, dict):
                errors.append(f"search.hits[{index}] must be an object")
                continue
            document_id = hit.get("document_id")
            if not isinstance(document_id, str) or not document_id:
                errors.append(f"search.hits[{index}].document_id is required")
            elif first_document_id is None:
                first_document_id = document_id
            provenance = hit.get("provenance")
            if not isinstance(provenance, dict):
                errors.append(f"search.hits[{index}].provenance must be an object")
                continue
            if not any(_absolute_http_url(provenance.get(key)) for key in ("source_url", "source_key")):
                errors.append(f"search.hits[{index}].provenance needs an absolute http(s) source_url/source_key")
            if not any(provenance.get(key) is not None for key in (
                "page_start", "page_end", "section", "chunk_index",
            )):
                errors.append(f"search.hits[{index}].provenance needs page/section/chunk attribution")
    confidence = search.get("confidence") if search else None
    required_confidence = {
        "confidence", "knowledge_gap", "external_research_recommended",
        "authoritative_sources", "independent_sources", "provenance_diagnostics",
    }
    if not isinstance(confidence, dict):
        errors.append("search.confidence must be an object")
    else:
        for key in sorted(required_confidence - set(confidence)):
            errors.append(f"search.confidence.{key} is required")
        if confidence.get("confidence") not in {"high", "medium", "low", "insufficient"}:
            errors.append("search.confidence.confidence must be high, medium, low, or insufficient")
        for key in ("knowledge_gap", "external_research_recommended"):
            if not isinstance(confidence.get(key), bool):
                errors.append(f"search.confidence.{key} must be boolean")
        for key in ("authoritative_sources", "independent_sources"):
            value = confidence.get(key)
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                errors.append(f"search.confidence.{key} must be a nonnegative integer")
        if not isinstance(confidence.get("provenance_diagnostics"), list):
            errors.append("search.confidence.provenance_diagnostics must be a list")

    def check_chunks(value: Any, name: str) -> list[int | float]:
        payload = _payload(value)
        chunks = payload.get("chunks") if payload else None
        if not isinstance(chunks, list) or not chunks:
            errors.append(f"{name}.chunks must be a non-empty ordered list")
            return []
        indexes: list[int | float] = []
        for index, chunk in enumerate(chunks):
            chunk_index = chunk.get("chunk_index") if isinstance(chunk, dict) else None
            if not isinstance(chunk_index, (int, float)) or isinstance(chunk_index, bool):
                errors.append(f"{name}.chunks[{index}].chunk_index must be numeric")
                continue
            if indexes and chunk_index <= indexes[-1]:
                errors.append(f"{name}.chunks must be strictly ordered by chunk_index")
            indexes.append(chunk_index)
        return indexes

    get_payload = _payload(get_value)
    continuation_required = False
    continuation_state = "not-checked"
    if get_value is not None:
        get_document = get_payload.get("document") if get_payload else None
        if not isinstance(get_document, dict) or get_document.get("document_id") != first_document_id:
            errors.append("get.document.document_id must equal the first search document_id")
        get_indexes = check_chunks(get_value, "get")
        next_after = get_payload.get("next_after_chunk") if get_payload else None
        if next_after is None:
            continuation_state = (
                "not-required-truncated-without-cursor-char-truncation-permitted"
                if get_payload and get_payload.get("truncated") is True
                else "not-required-no-cursor"
            )
        else:
            continuation_required = True
            continuation_state = "required"
            if not isinstance(next_after, (int, float)) or isinstance(next_after, bool):
                errors.append("get.next_after_chunk must be numeric when set")
            elif not get_indexes or next_after != get_indexes[-1]:
                errors.append("get.next_after_chunk must equal the last initial chunk_index")
            if continuation_value is None:
                errors.append("continuation is required when get.next_after_chunk is set")
            else:
                continuation_payload = _payload(continuation_value)
                continuation_document = continuation_payload.get("document") if continuation_payload else None
                if not isinstance(continuation_document, dict) or continuation_document.get("document_id") != first_document_id:
                    errors.append("continuation.document.document_id must equal the first search document_id")
                continuation_indexes = check_chunks(continuation_value, "continuation")
                if isinstance(next_after, (int, float)) and not isinstance(next_after, bool):
                    if continuation_indexes and continuation_indexes[0] <= next_after:
                        errors.append("continuation first chunk_index must be greater than get.next_after_chunk")
    elif require_get:
        errors.append("get result is required for search-mode contract validation")

    return {
        "ok": not errors,
        "contractErrors": errors,
        "firstDocumentId": first_document_id,
        "searchChecks": bool(search and isinstance(hits, list) and hits),
        "getChecks": get_value is not None and not any(error.startswith(("get.", "continuation")) for error in errors),
        "continuationRequired": continuation_required,
        "continuationState": continuation_state,
    }


async def probe(executable: str, cwd: str, mode: str, query: str) -> dict[str, Any]:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    params = StdioServerParameters(command=executable, args=[], cwd=cwd)
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            listed = await session.list_tools()
            tools = sorted(tool.name for tool in listed.tools)
            required = {
                "knowledge_search",
                "knowledge_get",
                "knowledge_sources",
                "knowledge_status",
                "knowledge_research",
                "knowledge_figures",
                "knowledge_get_figure",
                "knowledge_get_part_evidence",
            }
            output: dict[str, Any] = {
                "connected": True,
                "tools": tools,
                "requiredTools": sorted(required),
                "requiredToolsPresent": required.issubset(set(tools)),
            }
            knowledge_status = await session.call_tool("knowledge_status", {})
            output["knowledgeStatus"] = _decode_result(knowledge_status)
            if mode == "search":
                result = await session.call_tool(
                    "knowledge_search",
                    {"query": query, "top_k": 1},
                )
                output["search"] = _decode_result(result)
                initial = validate_probe_contract(output["search"])
                document_id = initial["firstDocumentId"]
                if document_id:
                    get_result = await session.call_tool(
                        "knowledge_get", {"document_id": document_id, "max_chunks": 1},
                    )
                    output["get"] = _decode_result(get_result)
                    get_payload = _payload(output["get"])
                    next_after = get_payload.get("next_after_chunk") if get_payload else None
                    if next_after is not None:
                        continuation = await session.call_tool(
                            "knowledge_get",
                            {"document_id": document_id, "max_chunks": 1, "after_chunk": next_after},
                        )
                        output["continuation"] = _decode_result(continuation)
                contract = validate_probe_contract(
                    output["search"], output.get("get"), output.get("continuation"), require_get=True,
                )
                output.update(contract)
                output["ok"] = bool(output["requiredToolsPresent"] and contract["ok"])
            else:
                output["contractErrors"] = []
                output["ok"] = bool(output["requiredToolsPresent"])
            output["status"] = "ok" if output["ok"] else "contract-error"
            return output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--mode", choices=("status", "search"), default="status")
    parser.add_argument("--query", default="DipTrace PCB layout")
    args = parser.parse_args()

    executable = Path(args.executable).expanduser().resolve()
    cwd = Path(args.cwd).expanduser().resolve()
    if not executable.is_file():
        raise SystemExit(f"RAG executable not found: {executable}")
    if not cwd.is_dir():
        raise SystemExit(f"RAG cwd not found: {cwd}")

    result = asyncio.run(probe(str(executable), str(cwd), args.mode, args.query))
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
