# Server Runtime V3

Runtime V3 turns the custom OpenCode web server into a durable control plane around the native OpenCode V2 service. OpenCode remains the model/tool execution engine; the custom server owns task lifecycle, provider-locked routing policy, context planning, shared repository/RAG state, policy enforcement and observability.

## Design rules

- The UI exposes model profiles rather than provider capability trivia or a separate orchestrator mode.
- Manual `direct` model selection is preserved exactly.
- Managed role profiles are provider-pinned; host resource state does not replace the selected model.
- Durable state lives in SQLite/WAL. Browser/PWA shutdown does not delete queued work, checkpoints, artifacts, decisions or telemetry.
- Permission/sandbox/tool policy is enforced server-side. The browser is not trusted to classify an action.
- Large data remains server-side as artifacts. Models receive compact summaries/IDs and fetch ranges only when needed.
- RAG and repository retrieval are server context sources; agents do not have to treat them as unrelated external black boxes.

## Durable task manager

`RuntimeStore` persists tasks, dependency edges, events, checkpoints, artifacts, token/cost usage, project memory, decisions, mailbox messages, caches and patch ownership.

Task states include queued, blocked, paused, submitted, running, waiting_permission, verifying, recovering, needs_attention, completed, failed and cancelled. Priorities are bounded and dependency-aware. The legacy `/client-queue.json` API remains a compatibility facade over the durable task store.

Pause/resume/cancel operate on server tasks. Resume uses the current OpenCode session/repository plus the last meaningful durable checkpoint instead of blindly resending the original request and attachments. In-flight tasks are recovered after a process restart.

## Model capability registry and profiles

The registry merges the OpenCode model catalog with server quality/cost hints and accumulated telemetry. Each model records provider/model ID, vision/tool support, context window/class, cost class, role hints and effort metadata.

Profiles:

- `direct`: preserve the exact user-selected provider/model.
- `fast`: Alibaba Qwen 3.8 Flash, low effort.
- `build`: Alibaba Qwen 3.7 Plus, medium effort, with bounded reader/planner escalation policy.
- `architect`: Alibaba Max planner + Flash reader + Plus builder.
- `critical`: architect stack + Alibaba DeepSeek independent reviewer.
- `research`: Max/Flash research path + DeepSeek contradiction check.
- `long-horizon`: Max planner + GLM executor + Flash reader + DeepSeek reviewer.

The role stack is provider-locked to the existing Alibaba Cloud/Bailian provider. Direct OpenAI selections remain on the official OpenAI provider.

Routing is deterministic. Runtime V3 does not change a model because of host load, a running game, GPU usage, or the availability of another inference endpoint.

## Reasoning effort

Canonical effort levels are:

```text
auto
minimal
low
medium
high
max
```

`max` is a semantic runtime request for the strongest effort supported by that model/provider. Provider adapters/variants translate it to the real provider setting.

Normal implementation escalation is:

```text
Plus / medium
→ Plus / high after a meaningful failed solution attempt
→ Max / high after repeated stall/replanning need
→ Max / max only for exceptional/critical reasoning
```

Effort escalation and model escalation are separate. A single failed command is not enough to switch models.

## Dynamic context manager

Runtime V3 uses OpenCode V2 native durable compaction instead of inventing a second conversation history format. The installed config keeps native automatic compaction enabled.

The custom preflight threshold is model-aware:

- resolve the active profile/model;
- read the model context limit from the registry;
- apply `contextPolicy.targetRatio` (normally around 0.70–0.72);
- reserve output/reasoning space;
- request native compaction only when active context exceeds that threshold.

Runtime tracks completed/requested compaction state and requires meaningful context growth before another custom request. It also avoids issuing another request while a native compaction is pending. Effort changes or role transitions do not themselves cause compaction.

The server context envelope is independently bounded and deduplicated. It can contain project instructions, persistent project memory, decision log entries, structured mailbox/handoff messages, semantic repository matches, changed symbols since the task baseline and server-managed engineering RAG retrieval.

## Shared repository index and semantic diff

A background maintenance loop refreshes active project indexes. The V3 index contains Python AST symbols with qualified names/line ranges, JS/TS-style symbol/import extraction, dependency/manifest metadata, dependency edges, a bounded Git graph, and file/symbol embeddings.

When `sentence-transformers` is available it can be used for embeddings. Otherwise the index falls back to deterministic hashed lexical embeddings, so indexing never requires an external API. Semantic diff maps Git changed line ranges back to indexed symbols.

## MCP gateway and lazy loading

OpenCode remains the central MCP host rather than duplicating a second protocol daemon. Installation enables OpenCode V2 MCP Code Mode for the knowledge server, so MCP schemas are not all injected into the provider tool list up front. Runtime V3 adds central policy, health/catalog metadata, rate limiting and secret handling around execution.

The OpenCode V2 runtime guard applies:

1. `session.context`: bounded server context for every managed client path before model dispatch.
2. `tool.execute.before`: sandbox, ownership, loop and rate-limit policy.
3. `tool.execute.after`: externalizes large results and deduplicates repeated task-scoped artifacts.
4. `shell.create.before`: strips server secrets and wraps commands in the selected sandbox.

Pre-execution tool-result caching is deliberately disabled: filesystem reads can change without a Git status transition. Repository indexes use a Git/content fingerprint instead.

## Permission previews

Permission classification operates on the actual pending backend request, never client-supplied action data. The server also produces a semantic compact preview for the UI. Full commands/resources remain available under disclosure. R3/R4 hard-interactive boundaries are unchanged.

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

`safe` and `repo-write` require `bwrap`, hide the user's home tree except for the selected repository, and disable network access. The explicit `OPENCODE_ALLOW_UNSANDBOXED=1` escape hatch is intended only for hosts where that weaker boundary has been consciously accepted.

Path containment is also enforced for file-mutation tools.

## Large outputs, context dedup and accounting

Large tool outputs are stored in `ArtifactStore` and exposed by ID plus bounded preview/range/search. Native OpenCode output is additionally bounded with `tool_output.max_lines` and `tool_output.max_bytes`. Server context sections are content-hash deduplicated before injection.

Per-task usage records planning, implementation, research, review and `wasted_retries`. Verification repair/recovery/retry work is separated from successful implementation usage.

## Mailbox and typed handoff

Agents exchange structured finding/question/patch/blocker/handoff messages through the durable mailbox. Typed planner/builder handoff objects live in task metadata and enter context only when relevant. Reader/research outputs should be bounded findings, not full agent transcripts.

## Verification, reviewer, failure and watchdogs

After writable work becomes idle, the server discovers a bounded formatter/lint/typecheck/test pipeline. Full command output is stored as artifacts and only concise failures are propagated. Failure classification separates code failures from network/environment/flaky failures. Only actionable code failures can enqueue targeted repair.

A diff-impact gate determines whether an independent review is worthwhile. Repeated mutation signatures are blocked by the pre-tool gateway, while progress signatures detect cyclic/stuck agents independently of elapsed wall-clock time.

## Worktree isolation and patch ownership

Parallel writable tasks can use detached Git worktrees. Ownership is tracked against the original project root, so conflicting paths are detected before mutation. `/client-worktree-merge.json` merges tracked changes with three-way Git apply and copies untracked files safely; it refuses to overwrite dirty/conflicting target paths and records durable merge checkpoints/events.

## Session branching and replay

Runtime branching uses native OpenCode session forks. State merge copies project memory/decisions and meaningful source-task checkpoints/handoff data. Git code merging remains independent and uses the worktree path above.

Completed/failed tasks can be captured as replay artifacts containing recorded OpenCode messages/tool results. Replay returns the recording plus task events/checkpoints/usage with `modelCalls: 0`.

## Telemetry

Runtime telemetry should expose the actual profile, role, requested/actual model, provider, requested/effective effort, reason for model/effort choice, latency and success/failure. This trace is the source of truth for model usage; model self-report is not.

## Remote notifications/API

Browser notifications and optional webhook delivery cover waiting-permission, needs-attention, failed and completed states. The authenticated remote API provides compact task/permission status and task control without loading the full desktop UI.

## Important environment settings

See `.env.example`. Routing-specific controls are the canonical role refs:

```text
OPENCODE_PLANNER_MODEL
OPENCODE_BUILDER_MODEL
OPENCODE_READER_MODEL
OPENCODE_REVIEW_MODEL
OPENCODE_LONG_HORIZON_MODEL
OPENCODE_ORCHESTRATED_MODEL
```

Other V3 controls cover embeddings, MCP limits, artifacts, loop detection, secrets, sandboxing and notifications.

## Regression gates

Zero-token regression covers the runtime/store/index/sandbox/context paths plus `scripts/model-routing-effort-smoke.py` for provider lock, effort translation, profile set and retired-router absence.

The merge gate is static/runtime verification → isolated fresh install/update render → composed web-server regression → final diff review → merge only after explicit approval.
