# Doctor diagnostics

Web UI exposes `Диагностика`, and `/doctor` opens the same panel without creating a session.

## Zero-token checks

Opening Doctor does **not** send an LLM prompt. It checks:

- OpenCode backend HTTP availability;
- rendered runtime `opencode.json`;
- `bailian-cli/qwen3.8-max` and `bailian-cli/qwen3.6-flash` in the current model catalog;
- Bailian Token Plan usage/auth availability through `bl usage token-plan --output json`;
- routing config: primary Max, `fast-reader` Flash, no automatic `ollama/*` agents;
- OpenCode `/api/mcp` status for `kb`;
- local RAG executable discovery;
- MCP protocol initialization and `list_tools` using the RAG venv;
- required RAG tools: `knowledge_search`, `knowledge_get`, `knowledge_sources`, `knowledge_status`;
- `knowledge_status`: Qdrant, corpus counts, model idle-unload and Qdrant timeout.

The independent MCP probe is intentional: a green OpenCode `kb: connected` alone does not prove that the expected tools can actually be discovered and called.

## Manual smoke tests

No paid smoke is started automatically. The UI asks for confirmation before every model-backed smoke, and the server allows only one Doctor smoke at a time.

- **RAG retrieval** — 0 LLM tokens. Starts a temporary MCP client and performs one local `knowledge_search(top_k=1)`. Local embedding/reranker compute is used.
- **Qwen Flash inference** — paid. Temporary scratch session, one short prompt to `qwen3.6-flash`, then cleanup.
- **Qwen Max inference** — paid. Temporary scratch session, one short prompt to `qwen3.8-max`, then cleanup.
- **Router E2E** — paid. Max is instructed to delegate a bounded file-read task to `fast-reader`; Doctor verifies a child session, `qwen3.6-flash`, the random marker, and absence of Ollama in the child trace.
- **Router + RAG E2E** — paid. Max delegates to `fast-reader`, which must call `kb_knowledge_search`; Doctor verifies child delegation, Flash, RAG tool use, final marker and no Ollama route.

Smoke workspaces are allocated under the isolated quick-session root. Parent/child smoke sessions are deleted after the check, and the scratch child is removed with the same containment guard used by normal quick sessions.

The browser stores only the last smoke result/timestamp in localStorage. It does not persist credentials or prompt contents.

## Failure interpretation

- Catalog PASS + inference FAIL: OpenCode config/catalog is present, but the provider request/auth/model runtime failed.
- MCP `kb` FAIL/disabled + direct MCP probe PASS: RAG itself works, but OpenCode did not connect it; rerun install/update and inspect rendered MCP config.
- MCP connected + direct MCP probe FAIL: the executable/server environment is broken even though OpenCode established a transport.
- Qdrant FAIL: RAG must fail open; ordinary OpenCode/model work should continue.
- Router E2E FAIL while Max/Flash inference PASS: provider access is good, but delegation policy/subagent execution is not working as intended.
- Router + RAG FAIL while Router and RAG retrieval PASS: the selective RAG handoff path is the broken layer.

GitHub CI is not a substitute for this host-level check because provider credentials, the local Qdrant corpus, the RAG venv and the installed OpenCode V2 backend exist only on the actual machine.
