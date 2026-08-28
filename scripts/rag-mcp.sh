#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [[ -f "$ROOT/.env" ]]; then
  set -a
  source "$ROOT/.env"
  set +a
fi

RAG_ROOT=${MCP_RAG_ROOT:-}
if [[ -z "$RAG_ROOT" ]]; then
  for candidate in "$ROOT/../mcp-rag" "$HOME/mcp-rag"; do
    if [[ -f "$candidate/pyproject.toml" && -x "$candidate/.venv/bin/knowledge-mcp" ]]; then
      RAG_ROOT=$candidate
      break
    fi
  done
fi

if [[ -z "$RAG_ROOT" ]]; then
  echo "RAG disabled: set MCP_RAG_ROOT to the mcp-rag checkout" >&2
  exit 78
fi

RAG_ROOT=$(cd "$RAG_ROOT" 2>/dev/null && pwd -P) || {
  echo "RAG root does not exist: $RAG_ROOT" >&2
  exit 78
}
RAG_BIN=${MCP_RAG_BIN:-"$RAG_ROOT/.venv/bin/knowledge-mcp"}
if [[ ! -x "$RAG_BIN" ]]; then
  echo "RAG MCP executable not found: $RAG_BIN" >&2
  exit 78
fi

cd "$RAG_ROOT"
exec "$RAG_BIN"
