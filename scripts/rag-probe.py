#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


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


async def probe(executable: str, cwd: str, mode: str, query: str) -> dict[str, Any]:
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
            }
            output: dict[str, Any] = {
                "connected": True,
                "tools": tools,
                "requiredToolsPresent": required.issubset(set(tools)),
            }
            status = await session.call_tool("knowledge_status", {})
            output["status"] = _decode_result(status)
            if mode == "search":
                result = await session.call_tool(
                    "knowledge_search",
                    {"query": query, "top_k": 1},
                )
                output["search"] = _decode_result(result)
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
