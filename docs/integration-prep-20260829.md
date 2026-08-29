# Backend / frontend / RAG integration handoff — 2026-08-29

Authoritative merge-ready backend branch:

`backend/runtime-v3-front-rag-ready`

This branch is based on the complete Runtime V3 server head from `main` (`ff7fbeb60ed9e34a32ffca36167930d1ee89cf98`) plus the original RAG integration preparation commit. It is the branch to use for the frontend merge and the final `mcp-rag` hookup. Do not use the stale `backend/server-runtime-v2` name for new integration work.

## What is already included

The branch contains the requested server/runtime architecture already present in Runtime V3: durable SQLite/WAL tasks and checkpoints, priority/dependencies/pause/resume/cancel, model capability profiles, adaptive local/cloud routing, dynamic context/compaction, context and tool-result caches, AST/symbol/embedding repository index, semantic diff, MCP policy/lazy-loading layer, scoped secret broker, sandbox profiles, resource scheduling, stage token/cost accounting, artifacts, mailbox/handoff, verification/review/failure/loop/stuck guards, worktree isolation, patch ownership, speculative research, shared RAG retrieval, project memory/decision log, session branching, remote status/actions, replay and telemetry.

The existing web UX also retains the requested interaction contract:

- only Build and Plan are user-facing execution modes;
- orchestration is a model profile, not a third mode;
- idle composer -> send;
- running + empty composer -> cancel;
- running + payload -> queue;
- permission requests use a compact summary with details behind disclosure.

## Stable frontend integration contract

The composed server exposes:

`GET /client-integration.json`

The response is deliberately path- and secret-free. It describes the stable managed routes, supported Runtime V3 profiles, composer behavior and RAG requirements. Frontend work should target this contract instead of depending on Python module internals.

Important managed routes:

- `POST /client-send.json` — managed immediate dispatch through Runtime V3;
- `GET /client-tasks.json` — durable task list;
- `POST /client-task-create.json` — create a durable queued/standalone task;
- `POST /client-task-control.json` — pause/resume/cancel/priority/dependency/checkpoint control;
- `GET /client-runtime-v3.json` — live Runtime V3 status;
- `GET /client-resource-status.json` — local/cloud/game-aware scheduler status;
- `GET /client-model-capabilities.json` — server capability registry;
- `GET /client-mcp-gateway.json` — MCP health/catalog metadata;
- `POST /client-rag-start.json` — non-destructive RAG preflight/connect flow.

The server-side task store is authoritative. A future frontend merge should not introduce a second persistent queue in browser storage. Temporary optimistic UI state is fine, but the durable task/queue state must come from the server endpoints above.

## Frontend branch merge rule

`feat/web-client-v2-candidate` is historically useful but is far behind the current runtime history. Do not merge that branch wholesale as a second backend baseline. Rebase/cherry-pick only genuinely newer frontend changes onto `backend/runtime-v3-front-rag-ready`, preserving the Runtime V3 server files and the stable contract above.

Current `main` already contains the V2 web modules (`app/api.js`, `app/app.js`, UX overlays and Runtime dashboards), so the integration job is to reconcile newer visual/frontend changes rather than resurrect the old branch history.

## RAG integration contract

RAG repository: `fireostendere/mcp-rag`.

The custom server already contains OpenCode V2-aware RAG lifecycle code in `app/server_rag.py` and launches the KB MCP through `scripts/rag-mcp.sh`.

The launcher is checkout-agnostic:

- prefer `MCP_RAG_ROOT` / `MCP_RAG_BIN`;
- allow sibling checkout discovery for development;
- never hardcode a user-specific absolute path;
- do not create, reset or replace the Qdrant collection during a connectivity check.

Required MCP tools after connection:

- `knowledge_search`;
- `knowledge_get`;
- `knowledge_sources`;
- `knowledge_status`.

The quick RAG path runs a model-free runtime preflight first. The full path performs the preflight, then a non-starting retrieval check, then connects `kb` to the current OpenCode workspace. Existing Qdrant data is treated as authoritative state and must survive unchanged.

## Data-safety gate before final merge

Before first combined production start:

1. Resolve the existing `mcp-rag` checkout with `MCP_RAG_ROOT`/`MCP_RAG_BIN` or safe sibling discovery.
2. Record Qdrant collection status plus document/chunk/point counts.
3. Run the model-free RAG preflight.
4. Connect `kb` MCP.
5. Verify all four required knowledge tools are exposed.
6. Run representative retrieval without re-ingestion.
7. Record the same collection/data counts again.
8. Fail the integration if startup recreated, reset or unexpectedly changed the collection.

## Merge preflight

Run from the repository root:

```bash
python3 scripts/integration-preflight.py
python3 scripts/integration-preflight.py --json
```

The preflight is static/model-free and does not touch Qdrant. It checks the frontend contract, Runtime V3 wiring, portable RAG launcher, non-destructive lifecycle markers and the UX contract.

Then run the repository regression gates already shipped with Runtime V3, including `scripts/verify-runtime-v3.sh`, `scripts/runtime-v3-smoke.py`, `scripts/runtime-v3-worktree-smoke.py`, `scripts/runtime-completion-smoke.py`, `scripts/install-regression.sh`, `scripts/web-server-smoke.py` and `scripts/install-runtime-v3-selftest.py` as applicable to the host.

GitHub-hosted Actions are not an acceptance signal until the known runner provisioning problem is fixed: recent jobs failed before a runner/step was assigned. Use the repository/local Linux regression gates for the integration decision.

## Final merge order

1. Start from `backend/runtime-v3-front-rag-ready`.
2. Rebase/cherry-pick the current frontend-only changes onto it.
3. Run frontend + Runtime V3 smokes.
4. Point `MCP_RAG_ROOT`/`MCP_RAG_BIN` at the existing RAG checkout; do not move runtime data.
5. Record RAG counts, run quick/full preflight, verify MCP tools and representative retrieval, re-check counts.
6. Run full local regression.
7. Merge the resulting integration branch to `main` only after these gates pass.
