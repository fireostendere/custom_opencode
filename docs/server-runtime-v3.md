# Server Runtime V3

Runtime V3 turns the custom OpenCode web server into a durable control plane around the native OpenCode V2 service. OpenCode remains the model/tool execution engine; the custom server owns task lifecycle, routing policy, context planning, shared repository/RAG state, policy enforcement and observability.

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

Profiles include:

- `direct`: preserve the user-selected model and use direct Build/Plan agents.
- `qwen3.8-coder`: coding profile with adaptive local/cloud routing.
- `qwen3.8-orchestrated`: cloud orchestration profile; orchestration is a model profile, not a visible work mode.
- `qwen3.8-review`: safe read-only review profile.
- `qwen3.8-fast`: cheap/fast research path.

The adaptive scheduler incorporates task profile requirements, historical success rate/latency, cost class, local-provider health, CPU pressure, configured game processes and GPU/VRAM pressure. A hysteresis window prevents rapid local/cloud flapping. Resource transitions can invoke configured pause/resume hooks for local inference, embeddings, Whisper or other user-managed workers.

## Dynamic context manager

Runtime V3 uses OpenCode V2 native durable compaction instead of inventing a second conversation history format. The installed config enables native automatic compaction with a reserved tail, and Runtime V3 checks active context against the selected profile/model budget. When active context exceeds that budget it requests native compaction and applies a cooldown.

The server context envelope is independently bounded and deduplicated. It can contain project instructions, persistent project memory, decision log entries, structured mailbox/handoff messages, semantic repository matches, changed symbols since the task baseline and server-managed engineering RAG retrieval.

## Shared repository index and semantic diff

A background maintenance loop refreshes active project indexes. The V3 index contains Python AST symbols with qualified names/line ranges, JS/TS-style symbol/import extraction, dependency/manifest metadata, dependency edges, a bounded Git graph, and file/symbol embeddings.

When `sentence-transformers` is available it can be used locally. Otherwise the index falls back to deterministic local hashed lexical embeddings, so indexing never requires an external API. Semantic diff maps Git changed line ranges back to indexed symbols.

## MCP gateway and lazy loading

OpenCode remains the central MCP host rather than duplicating a second protocol daemon. Installation enables OpenCode V2 MCP Code Mode for the knowledge server, so MCP schemas are not all injected into the provider tool list up front. Runtime V3 adds central policy, health/catalog metadata, read-result caching, rate limiting and secret handling around execution.

The OpenCode V2 runtime guard applies:

1. `session.request`: bounded server context for non-web clients.
2. `tool.execute.before`: sandbox, ownership, loop and rate-limit policy.
3. `tool.transform`: wraps cacheable read executors so a cache hit prevents the underlying tool call entirely.
4. `tool.execute.after`: externalizes large results and deduplicates repeated outputs.
5. `shell.create.before`: strips server secrets and wraps commands in the selected sandbox.

The pre-execution cache is restricted to deterministic/bounded reads: read/glob/grep/list/lsp, a narrow allowlist of read-only Git/filesystem shell commands, and selected knowledge read tools. Cache keys include tool input plus Git HEAD and working-tree status, so repository changes invalidate cached repository reads automatically.

## Permission previews

Permission classification still operates on the actual pending backend request, never client-supplied action data. The server now also produces a semantic compact preview for the UI, for example `Удалить 7 объектов в build/`, `Изменить 2 файла в src/`, or a bounded Git command summary. Full commands/resources remain available under the existing disclosure. R3/R4 hard-interactive boundaries are unchanged.

## Secret broker

Runtime diagnostics expose secret references only. Values are never serialized to browser snapshots. The scoped broker supports allowlisted prefixes, optional per-scope name rules and short-lived single-use leases. Agent-created shell environments have secret-prefix variables stripped before execution; only explicitly configured secret references may be injected for an allowed shell scope.

Provider credentials still live in the server/OpenCode service environment because the provider process itself requires them. They are not sent to the browser or placed into model context.

## Sandbox profiles

Supported profiles are:

- `safe`: read-oriented; writes and arbitrary shell mutation are rejected. With bubblewrap, shell commands use a read-only project bind and no network.
- `repo-write`: edits are limited to the managed project/worktree; bubblewrap provides a writable project bind when available.
- `docker`: shell execution runs in a configured Docker image; network is disabled unless explicitly enabled.
- `wsl`: shell execution runs through WSL when available.
- `full-machine`: requires explicit `OPENCODE_ALLOW_FULL_MACHINE=1`.

Path containment is also enforced for file-mutation tools.

## Large outputs, context dedup and accounting

Large tool outputs are stored in `ArtifactStore` and exposed by ID plus bounded preview/range/search. Native OpenCode output is additionally bounded with `tool_output.max_lines` and `tool_output.max_bytes`. Server context sections are content-hash deduplicated before injection.

Per-task usage records planning, implementation, research, review and `wasted_retries`. Verification repair/recovery/retry work is deliberately separated from successful implementation usage so the dashboard/router can measure wasted retry cost rather than hiding it inside implementation totals.

## Mailbox and typed handoff

Agents exchange structured finding/question/patch/blocker/handoff messages through the durable mailbox. Typed planner/builder handoff objects live in task metadata and enter context only when relevant. Speculative researchers use independent read-only forks and feed structured findings to their dependent aggregator task.

## Verification, reviewer, failure and watchdogs

After writable work becomes idle, the server discovers a bounded formatter/lint/typecheck/test pipeline. Full command output is stored as artifacts and only concise failures are propagated. Failure classification separates code failures from network/environment/flaky failures. Only actionable code failures can enqueue targeted repair.

A diff-impact gate determines whether a full review task is worthwhile. Repeated mutation signatures are blocked by the pre-tool gateway, while progress signatures detect cyclic/stuck agents independently of elapsed wall-clock time.

## Worktree isolation and patch ownership

Parallel writable tasks can use detached Git worktrees. Ownership is tracked against the original project root, so conflicting paths are detected before mutation. `/client-worktree-merge.json` merges tracked changes with three-way Git apply and copies untracked files safely; it refuses to overwrite dirty/conflicting target paths and records durable merge checkpoints/events.

## Session branching and agent-state merge

Runtime branching uses native OpenCode session forks. State merge now copies project memory/decisions and also transfers meaningful source-task checkpoints, typed handoff data, route/state metadata into a structured `handoff` mailbox message for the selected target task. The target receives a `branch-state-merged` checkpoint. Git code merging remains independent and uses the worktree path above.

## Replay, telemetry and adaptive routing

Completed/failed tasks can be captured as replay artifacts containing recorded OpenCode messages/tool results. Replay returns the recording plus task events/checkpoints/usage with `modelCalls: 0`.

Per-model success/latency/cost telemetry feeds adaptive routing. The dashboard exposes active tasks, queue state, usage, GPU/VRAM pressure, MCP health/Code Mode state and learned model statistics.

## Remote notifications/API

Browser notifications and optional webhook delivery cover waiting-permission, needs-attention, failed and completed states. The compact authenticated remote API adds:

- `GET /client-remote-status.json`: tasks plus pending permissions with semantic previews;
- `POST /client-remote-action.json`: task cancel/pause/resume and permission `once`/`reject`.

This is sufficient for a phone/Tailscale client without loading the full desktop UI. Webhook delivery remains opt-in for non-loopback destinations.

## Important environment settings

See `.env.example`. Notable controls include `OPENCODE_RUNTIME_PLUGIN_TOKEN`, game/CPU/GPU/VRAM thresholds, resource pause/resume hooks, embedding backend/model, MCP rate limit, tool artifact/cache TTL, loop limit, scoped secret rules, Docker/WSL/full-machine controls, and notification webhook settings.

## Regression gates

Zero-token regression covers:

- `scripts/runtime-smoke.py`
- `scripts/runtime-resume-smoke.py`
- `scripts/runtime-v3-smoke.py`
- `scripts/runtime-v3-worktree-smoke.py`
- `scripts/runtime-completion-smoke.py`
- `scripts/verify-runtime-v3.sh`
- `scripts/install-regression.sh`
- `scripts/web-server-smoke.py`
- `scripts/install-runtime-v3-selftest.py` after a real installation

The merge gate is static/runtime verification → isolated fresh install/update render → composed web-server regression → final diff review → fast-forward into `main`.
