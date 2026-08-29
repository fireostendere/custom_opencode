# Integration preparation — 2026-08-29

This branch is the staging point for the backend/frontend/RAG integration. Do not merge it to `main` until the combined regression is green.

## Baseline

- Integration branch: `integration/rag-opencode-v2-20260829`
- Created from current `main`.
- OpenCode upstream target: V2 beta (`opencode2`, package `@opencode-ai/cli@beta`).
- RAG repository: `fireostendere/mcp-rag`.

## Existing integration surface

The custom server already contains OpenCode V2-aware RAG lifecycle code in `app/server_rag.py` and launches the KB MCP through `scripts/rag-mcp.sh`.

The RAG launcher must remain checkout-agnostic:

- prefer `MCP_RAG_ROOT` / `MCP_RAG_BIN`;
- allow sibling checkout discovery for development;
- do not hardcode a user-specific absolute path;
- do not create, reset, or replace the Qdrant collection during a connectivity check.

## Merge order

1. Merge backend work into this integration branch.
2. Run backend/runtime tests.
3. Merge frontend work.
4. Run web build + API/UI smoke tests.
5. Merge the RAG work last.
6. Verify existing RAG data before and after startup.
7. Run full regression before merging this branch to `main`.

## RAG safety gates

Before first combined start:

- resolve the existing `mcp-rag` checkout without moving/copying runtime data;
- verify Qdrant is reachable and the expected collection already exists;
- record document/chunk/point counts;
- run model-free RAG preflight;
- connect `kb` MCP to the OpenCode V2 workspace;
- verify `knowledge_search`, `knowledge_get`, `knowledge_sources`, and `knowledge_status` are exposed;
- compare counts again and fail the integration if startup changed or recreated the collection unexpectedly.

## Temporary connectivity smoke

A separate RAG branch, `chore/integration-link-smoke-20260829`, contains `docs/integration-link-smoke.md` only to verify the ChatGPT ↔ GitHub write path. It must not be merged into the final integration; delete the temporary marker/branch after the real RAG branch is connected.

## Next integration work

- reconcile the current backend and frontend branches against this branch;
- compare the custom OpenCode API assumptions with the current V2 beta contract;
- run a real `opencode2` + custom server + existing RAG end-to-end smoke test;
- update permanent documentation only after the contract is verified.
