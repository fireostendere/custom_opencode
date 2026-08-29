# Server Runtime V3

Runtime V3 turns the custom OpenCode web server into a durable control plane around the native OpenCode V2 service. The OpenCode service remains the model/tool execution engine; the custom server owns task lifecycle, routing policy, context planning, shared repository/RAG state, policy enforcement and observability.

## Design rules

- The UI exposes Build/Plan and model profiles, not provider capability trivia or a separate orchestrator mode.
- Manual `direct` model selection is preserved. Automatic local/cloud routing applies only to server profiles that opt into it.
- Durable state lives in SQLite/WAL. Browser/PWA shutdown does not delete queued work, checkpoints, artifacts, decisions or telemetry.
- Permission/sandbox/tool policy is enforced server-side. The browser is not trusted to classify an action.
- Large data remains server-side as artifacts. Models receive compact summaries/IDs and fetch ranges only when needed.
- RAG and repository retrieval are server context sources; agents do not have to treat them as unrelated external black boxes.

## Durable task manager

`RuntimeStore` persists tasks, dependency edges, events, checkpoints, artifacts, token/cost usage, project memory, decisions, mailbox messages, caches and patch ownership.

Task states include queued, blocked, paused, submitted, running, waiting_permission, verifying, recovering, needs_attention, completed, failed and cancelled. Priorities are bounded and dependency-aware. The legacy `/client-queue.json` API remains a compatibility facade over the durable task store.

Pause/resume/cancel operate on server tasks. Resume uses the current OpenCode session/repository plus the last meaningful durable checkpoint instead of blindly resending the original request and attachments. In-flight tasks are recovered after a process restart.

## Model capability registry and profiles

The registry merges the OpenCode model catalog with server quality/cost hints and locally accumulated telemetry. Each model records provider/model ID, vision support, tool calling support, context window/class, cost class, fast-path suitability and coding/review/planning scores.

Profiles currently include:

- `direct`: preserve the user-selected model and use direct Build/Plan agents.
- `qwen3.8-coder`: coding profile with adaptive local/cloud routing.
- `qwen3.8-orchestrated`: cloud orchestration profile; orchestration is a model profile, not a visible work mode.
- `qwen3.8-review`: safe read-only review profile.
- `qwen3.8-fast`: cheap/fast research path.

The adaptive scheduler incorporates task profile requirements, historical success rate/latency, cost class, local-provider health, CPU pressure, configured game processes and GPU/VRAM pressure. A hysteresis window prevents rapid local/cloud flapping. Resource transitions can invoke configured pause/resume hooks for local inference, embeddings, Whisper or other user-managed workers.

## Dynamic context manager

Runtime V3 uses OpenCode V2 native durable compaction instead of inventing a second conversation history format. The installed config enables native automatic compaction with a reserved tail, and Runtime V3 also checks active context against the selected profile/model budget. When the active context exceeds that budget it requests native compaction and applies a cooldown.

The server context envelope is independently bounded and deduplicated. It can contain:

- project instructions and persistent project memory;
- decision log entries;
- structured mailbox/handoff messages;
- semantic repository matches;
- changed symbols since the task baseline;
- server-managed engineering RAG retrieval.

This prevents old server-added context, duplicate tool output and repeated repository metadata from growing without bound.

## Shared repository index

A background maintenance loop refreshes active project indexes. The V3 index contains:

- Python AST symbols with qualified names and line ranges;
- JS/TS-style symbol/import extraction;
- dependency/manifest metadata;
- internal/external dependency edges;
- a bounded Git commit graph;
- file/symbol embeddings.

When `sentence-transformers` is available it can be used locally. Otherwise the index falls back to deterministic local hashed lexical embeddings, so indexing never requires an external API.

Semantic diff maps Git changed line ranges back to indexed symbols. The context planner can therefore say which functions/classes changed instead of providing only a file list.

## MCP gateway and lazy loading

OpenCode remains the central MCP host. Installation enables OpenCode V2 MCP Code Mode for the knowledge server, so native MCP schemas are not all injected into the provider tool list up front. The model first sees the compact Code Mode execution surface and the required namespace/tool schema is resolved when needed.

Runtime V3 layers a server policy gateway on tool execution using the OpenCode V2 plugin hooks:

1. `session.request` injects bounded server context for non-web clients.
2. `tool.execute.before` applies sandbox, ownership, loop and rate-limit policy before execution.
3. `tool.execute.after` deduplicates/externalizes oversized tool results.
4. `shell.create.before` strips server secrets and wraps commands in the selected sandbox.

The MCP gateway API exposes health/resource/tool-ID metadata without credentials. Shared RAG calls also use a TTL cache, so repeated read-only retrieval does not repeatedly start identical work.

## Secret broker

Runtime diagnostics expose secret names/references only. Values are never serialized to browser snapshots. The scoped broker supports allowlisted prefixes, optional per-scope name rules and short-lived single-use leases. Agent-created shell environments have secret-prefix variables stripped before execution; only explicitly configured secret references may be injected for an allowed shell scope.

Provider credentials still live in the server/OpenCode service environment because the provider process itself requires them. They are not sent to the browser or placed into model context.

## Sandbox profiles

Supported profiles are:

- `safe`: read-oriented; writes and arbitrary shell mutation are rejected. If bubblewrap is available, shell commands run with a read-only project bind and no network.
- `repo-write`: edits are limited to the managed project/worktree; bubblewrap provides a writable project bind when available.
- `docker`: shell execution is moved into a configured Docker image; network is disabled unless explicitly enabled.
- `wsl`: shell execution is moved through WSL when available.
- `full-machine`: requires the explicit `OPENCODE_ALLOW_FULL_MACHINE=1` opt-in.

Path containment is also enforced for OpenCode file mutation tools. Docker/WSL profiles still use the managed worktree as the source-of-truth filesystem; file edits remain path-contained while shell/build execution occurs in the selected runner.

## Tool result cache and large outputs

Runtime caches model catalogs, repository indexes, MCP health/catalog metadata, shared RAG reads and duplicate tool-result hashes. Identical large tool results are replaced with a compact artifact reference after the first capture. Large logs are stored in `ArtifactStore` and support bounded range/search access from the API/UI.

Native OpenCode tool output is additionally bounded at install time with `tool_output.max_lines` and `tool_output.max_bytes`.

## Mailbox and typed handoff

Subagents can exchange structured mailbox messages such as finding, question, patch or blocker without copying large prose into a parent conversation. Typed handoff objects are persisted in task metadata and included in bounded context only when relevant.

Speculative research forks two or three read-only sessions using the fast profile. The aggregator depends on those tasks and receives their findings through the mailbox before continuing.

## Verification and review

After a writable task becomes idle, the verification pipeline discovers a bounded set of formatter/lint/typecheck/test commands appropriate to the project. Full command output is stored as artifacts; only concise failure summaries are propagated.

Failure classification separates code failures from network/environment/flaky failures. Only actionable code failures can enqueue a targeted verification-fix task. A cheap diff-impact gate determines whether a full review task is warranted; trivial bounded changes skip the expensive review profile.

## Loop/stuck protection

The server tracks tool signatures, message/repository progress signatures and repeated mutations. Repeated mutation signatures are blocked by the V3 pre-tool gateway; the older progress monitor also records cyclic tool patterns and tasks that stop making progress. The configured stuck action may warn or interrupt/pause the task.

## Worktree isolation and patch ownership

Standalone parallel writable tasks can run in detached Git worktrees. Patch ownership is keyed to the original project root even when the actual task directory is a worktree, so two parallel agents that attempt to own the same path are detected before mutation and again during progress polling.

`/client-worktree-merge.json` merges an isolated task back into its project root using a three-way Git apply against the task baseline plus safe copying of untracked files. It refuses to overwrite target paths that already contain uncommitted changes and records a durable merge checkpoint/event. Cleanup is explicit and fail-closed.

## Session branching and state merge

Runtime session branching uses native OpenCode session forks. State merge records the relationship and copies persistent project decisions/memory into the selected target state. Git code merging remains independent; isolated code changes use the worktree merge path above.

## Replay and telemetry

Completed/failed managed tasks are automatically captured as replay artifacts containing recorded OpenCode messages/tool results. Replay APIs return the recording plus durable task events/checkpoints/usage and make no model calls (`modelCalls: 0`). This is intended for debugging the custom runtime without paying to reproduce the original model run.

Per-task usage is stored by stage (planning, implementation, research, review, verification repair) with input/output/cache tokens, cost, latency and success. Aggregated per-model statistics feed the adaptive router rather than remaining passive UI metrics.

## Remote API and dashboard

The authenticated web API exposes task control, queue/dependencies, checkpoints/events, artifacts, semantic repo search, MCP gateway health, model telemetry, session branch/state merge, sandbox selection, worktree merge and zero-token replay. An optional webhook emits significant task states; non-loopback webhooks require an explicit remote-notification opt-in.

The existing Task Center remains the main UI. Runtime V3 adds a collapsible control-plane section showing GPU/VRAM pressure, adaptive router state, MCP Code Mode/lazy status, service coverage and model telemetry. It also exposes semantic repo search, sandbox selection, branch/state merge, worktree merge and replay without adding capability clutter to the normal composer/model UI.

## Important environment settings

See `.env.example` for the complete set. Notable controls include:

- `OPENCODE_RUNTIME_PLUGIN_TOKEN`, `OPENCODE_RUNTIME_PLUGIN_HOST`;
- `OPENCODE_GAME_PROCESSES`, CPU/GPU/VRAM thresholds and router hysteresis;
- `OPENCODE_RESOURCE_PAUSE_COMMAND`, `OPENCODE_RESOURCE_RESUME_COMMAND`;
- `OPENCODE_REPO_EMBEDDINGS`, `OPENCODE_REPO_EMBED_MODEL`;
- `OPENCODE_MCP_RATE_LIMIT`, `OPENCODE_TOOL_ARTIFACT_THRESHOLD`, `OPENCODE_LOOP_LIMIT`;
- `OPENCODE_SECRET_PREFIXES`, `OPENCODE_SECRET_SCOPES`, `OPENCODE_SHELL_SECRET_REFS`;
- Docker/WSL/full-machine sandbox controls;
- `OPENCODE_NOTIFICATION_WEBHOOK` and remote opt-in.

## Regression gates

The runtime has separate zero-token architecture smokes plus the repository's existing verifier:

- `scripts/runtime-smoke.py`
- `scripts/runtime-resume-smoke.py`
- `scripts/runtime-v3-smoke.py`
- `scripts/runtime-v3-worktree-smoke.py`
- `scripts/verify-runtime-v3.sh`
- `scripts/install-regression.sh`
- `scripts/web-server-smoke.py`
- `scripts/install-runtime-v3-selftest.py` after a real installation

The merge gate is: static/runtime verification → isolated fresh install/update render → composed web-server regression → real post-install health checks when a real OpenCode service is present.
