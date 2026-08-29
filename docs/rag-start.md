# `/rag-start`

The web client handles `/rag-start` locally. It does not send the command to an LLM and therefore does not consume Qwen/OpenAI tokens.

## Modes

```text
/rag-start
/rag-start full
```

Full mode:

1. locates `mcp-rag` via `MCP_RAG_ROOT`, adjacent `../mcp-rag`, or `~/mcp-rag`;
2. executes the RAG venv Python module `knowledge_base.runtime`;
3. checks/starts local Qdrant with bounded timeouts;
4. verifies non-empty corpus + Qdrant collection;
5. runs one local retrieval smoke (`DipTrace PCB layout`), using no LLM tokens;
6. resolves the currently selected OpenCode session to its server-side workspace directory;
7. dynamically registers/connects `kb` through the current OpenCode MCP API;
8. verifies the MCP protocol and required tools;
9. atomically persists only `mcp.servers.kb.disabled=false` in the rendered runtime config so later workspaces/restarts can auto-connect;
10. opens Doctor after completion so the final runtime state is visible.

```text
/rag-start quick
```

Quick mode skips the embedding/reranker retrieval smoke. It still checks Qdrant, corpus readiness, connects the current workspace, verifies MCP tools and persists enablement.

## Failure behavior

The command is idempotent and protected by a mutex: repeated calls do not create multiple Qdrant containers or concurrent start attempts.

It never starts a remote Qdrant host, never runs arbitrary Docker services, never rebuilds/ingests the corpus, and never accepts an arbitrary filesystem directory from the browser. The browser sends only the selected `sessionID`; the server resolves the workspace using OpenCode itself.

If Docker is unavailable, the RAG venv is missing, the corpus is empty, the index is incompatible, retrieval fails, or `kb` cannot reach `connected`, the command returns a bounded structured failure and opens Doctor instead of looping indefinitely.

## Runtime ownership

OpenCode remains the supervisor of the `knowledge-mcp` stdio process. `/rag-start` does not launch a second standalone MCP daemon. The only infrastructure process it may start is the repository's fixed Qdrant Compose service.
