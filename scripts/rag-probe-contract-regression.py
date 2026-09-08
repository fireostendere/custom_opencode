#!/usr/bin/env python3
"""Pure local regression tests for the mcp-rag probe contract."""
from __future__ import annotations

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("rag_probe", ROOT / "scripts" / "rag-probe.py")
if not SPEC or not SPEC.loader:
    raise ImportError("cannot load rag-probe contract validator")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
validate_probe_contract = MODULE.validate_probe_contract


def valid_search() -> dict[str, object]:
    return {
        "hits": [{
            "document_id": "document-1",
            "provenance": {"source_url": "https://example.test/manual", "chunk_index": 0},
        }],
        "confidence": {
            "confidence": "high",
            "knowledge_gap": False,
            "external_research_recommended": False,
            "authoritative_sources": 1,
            "independent_sources": 1,
            "provenance_diagnostics": [],
        },
    }


def assert_ok(result: dict[str, object]) -> None:
    assert result["ok"], result["contractErrors"]


def assert_error(result: dict[str, object], expected: str) -> None:
    assert not result["ok"], result
    assert any(expected in error for error in result["contractErrors"]), result["contractErrors"]


def main() -> int:
    assert_ok(validate_probe_contract(valid_search()))

    missing_provenance = valid_search()
    missing_provenance["hits"][0]["provenance"] = {"source": "/local/corpus", "chunk_index": 0}  # type: ignore[index]
    assert_error(validate_probe_contract(missing_provenance), "absolute http(s)")

    missing_confidence = valid_search()
    missing_confidence.pop("confidence")
    assert_error(validate_probe_contract(missing_confidence), "search.confidence")

    assert_error(validate_probe_contract({}), "search.confidence")

    initial = {"document": {"document_id": "document-1"}, "chunks": [{"chunk_index": 0}], "next_after_chunk": 0}
    continuation = {"document": {"document_id": "document-1"}, "chunks": [{"chunk_index": 1}], "next_after_chunk": None}
    assert_ok(validate_probe_contract(valid_search(), initial, continuation, require_get=True))

    invalid_cursor = {"document": {"document_id": "document-1"}, "chunks": [{"chunk_index": 0}], "next_after_chunk": 1}
    assert_error(validate_probe_contract(valid_search(), invalid_cursor, continuation, require_get=True), "last initial")

    invalid_order = {"document": {"document_id": "document-1"}, "chunks": [{"chunk_index": 0}], "next_after_chunk": 0}
    repeated_chunk = {"document": {"document_id": "document-1"}, "chunks": [{"chunk_index": 0}]}
    assert_error(validate_probe_contract(valid_search(), invalid_order, repeated_chunk, require_get=True), "greater than")

    char_truncated = {"document": {"document_id": "document-1"}, "chunks": [{"chunk_index": 0}], "truncated": True, "next_after_chunk": None}
    result = validate_probe_contract(valid_search(), char_truncated, require_get=True)
    assert_ok(result)
    assert result["continuationState"] == "not-required-truncated-without-cursor-char-truncation-permitted"
    wrong_document = {"document": {"document_id": "document-2"}, "chunks": [{"chunk_index": 0}]}
    assert_error(validate_probe_contract(valid_search(), wrong_document, require_get=True), "first search document_id")
    print("rag-probe contract regression passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
