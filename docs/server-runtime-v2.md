# Server Runtime V2

Server Runtime V2 turns the custom web server from a thin prompt/queue adapter into a durable local control plane. It is composed by `app/server_workflow.py` and implemented primarily in:

- `app/server_runtime.py` — task lifecycle, worker integration and authenticated runtime API;
- `app/runtime_store.py` — SQLite/WAL durable state;
- `app/model_registry.py` — model capabilities, server profiles and resource-aware routing;
- `app/repo_services.py` — repository/context/artifact/verification helpers;
- `app/runtime-dashboard.js` / `.css` — Task Center and server-profile UI.

The legacy `/client-queue.json` contract remains available as a compatibility facade. New work is persisted as runtime tasks.

## Durable task model

Runtime state is stored in `runtime-v2.sqlite3` by default. The path can be overridden with `CUSTOM_OPENCODE_RUNTIME_DB`.

Task states include:

```text
queued -> submitted -> running -> verifying -> completed
   |          |          |
 blocked    paused   waiting_permission
   |                     |
   +---------------------+

recovering / needs_attention / failed / cancelled
```

Tasks support:

- priority;
- dependencies;
- cancel;
- pause/resume;
- durable checkpoints;
- event history;
- baseline Git snapshot;
- route metadata;
- per-task verification results;
- per-stage usage accounting.

On server restart, in-flight tasks are recovered instead of being silently forgotten. Recovery does not fabricate lost model output: a task is reattached when the upstream session is still active, otherwise it is paused for an explicit resume.

## Server model profiles

The UI still exposes only `Build` and `Plan` as execution modes. Orchestration and routing are model profiles.

Current server profiles:

- `direct` — preserve the exact provider/model/variant selected in OpenCode;
- `qwen3.8-orchestrated` — cloud-pinned Qwen orchestration alias;
- `gpt-5.6-sol-orchestrated` — cloud-pinned SOL orchestration alias.

`CapabilityRegistry` merges the current OpenCode model catalog with server hints such as:

- vision support;
- tool calling;
- context-window class;
- cost class;
- fast-path flag;
- coding/review/planning quality hints;
- accumulated local runtime telemetry when available.

The capability details remain server-side; the model picker shows only compact profiles.

### Important routing rule

`direct` never changes an explicitly selected model. Only an explicitly selected orchestration alias is provider-pinned.

## Resource scheduler

`ResourceScheduler` keeps a direct ref unchanged and routes an explicit orchestration profile to its configured provider model.

Relevant settings:

```text
OPENCODE_RESOURCE_SCHEDULER=auto
OPENCODE_GAME_PROCESSES=
OPENCODE_RESOURCE_CPU_THRESHOLD=0.85
OPENCODE_RESOURCE_PAUSE_COMMAND=
OPENCODE_RESOURCE_RESUME_COMMAND=
OPENCODE_LOCAL_CODER_MODEL=ollama/qwen3.8:27b
OPENCODE_CLOUD_CODER_MODEL=bailian-cli/qwen3.8-max
OPENCODE_FAST_MODEL=bailian-cli/qwen3.6-flash
OPENCODE_REVIEW_MODEL=bailian-cli/qwen3.8-max
```

The process detector sees processes in the server OS namespace. When the server runs inside WSL and the game runs only in Windows, configure an external process snapshot/integration or pause/resume command instead of assuming `/proc` sees the Windows process.

Pause/resume commands are hooks. Runtime V2 does not yet maintain a universal registry of every local Whisper/embedding/inference process.

## Context and repository services

`RepoIndexer` keeps a bounded cached repository index for active projects. The current implementation contains:

- tracked file inventory;
- regex-based symbol index for common languages;
- dependency/entry-file metadata;
- Git HEAD/status fingerprint;
- changed-file semantic-diff summary.

It is intentionally bounded by file count and indexed bytes.

This is **not yet** a full Tree-sitter/LSP AST index, embedding index, Git graph database or resolved dependency graph. Those are follow-up layers.

`ContextService` builds a bounded server context envelope from:

- project instructions;
- project memory;
- decision log;
- semantic diff from task baseline;
- cached repository dependency metadata;
- task mailbox;
- typed handoff.

Identical server-generated sections are deduplicated and the envelope is truncated to its budget.

This currently controls only context injected by the custom server. It does **not** replace OpenCode's own conversation-history compaction and therefore does not yet summarize/compress arbitrary old session messages before OpenCode sends them to a model.

## Cache and large outputs

The SQLite cache is used for server-owned repeatable reads such as:

- model catalog;
- repository index;
- MCP health/catalog metadata.

The cache infrastructure can be reused by additional tools.

Runtime V2 does not yet transparently intercept every shell/tool/MCP read call, so arbitrary tool-result deduplication is not complete.

`ArtifactStore` stores large text outside the conversation and exposes bounded range/search reads. Verification logs already use this path. Arbitrary upstream tool output is not yet automatically converted to an artifact; callers must use the runtime artifact path.

## Agent coordination

The runtime provides:

- structured mailbox messages (`finding`, `question`, `patch`, `blocker`, etc.);
- typed handoff metadata;
- speculative research (2–3 cheap read-only forks + dependent aggregator);
- task dependencies;
- patch ownership/conflict events.

Speculative research uses the mailbox automatically. Generic OpenCode subagents are not yet forced through the mailbox protocol.

Handoff storage is typed JSON, but automatic planner-to-builder schema generation/validation remains a follow-up.

## Verification and review

After a writable task becomes idle, the server runs a bounded verification pipeline when it can infer suitable commands.

Currently discovered checks include common:

- npm/pnpm/yarn lint;
- typecheck/check scripts;
- tests;
- pytest;
- `cargo check`;
- `go test ./...`.

Full formatter discovery is not implemented yet.

Failures are classified as:

- `network`;
- `environment`;
- `flaky`;
- `code`.

Only code failures are eligible for automatic repair tasks. Logs are stored as artifacts and only bounded failure summaries are carried forward.

Automatic review currently uses a deterministic diff-size/sensitive-path gate. When the gate decides a full review is needed, it enqueues the configured hidden review profile. A separate cheap-model classifier is not used yet.

## Loop, stuck and conflict detection

Runtime V2 tracks progress from upstream message usage/signatures plus Git status.

- repeated tool signatures emit `agent.loop_detected`;
- repeated unchanged progress emits `agent.stuck`;
- `OPENCODE_STUCK_ACTION=interrupt` can pause a stuck task;
- overlapping changed paths emit patch-conflict events.

Loop detection currently reports the loop but does not automatically switch the model/strategy. Patch ownership is primarily path-level; symbol-level ownership is reserved by the schema but not populated by the current Git-status monitor.

## Git worktrees

Standalone tasks may request isolation. The server creates a detached Git worktree and a separate OpenCode session for that worktree.

Cleanup is fail-closed: a managed worktree with uncommitted changes is never deleted automatically.

Automatic merge/rebase/cherry-pick of completed worktree changes is not implemented yet.

## MCP gateway status

`/client-mcp-gateway.json` is currently a server-side **health/catalog facade**:

- one authenticated place to view namespaces and health;
- short-lived server cache;
- compact namespace-first presentation;
- `kb` can expose its tool names lazily.

It is **not yet a full MCP protocol proxy**. Existing MCP servers are still configured in OpenCode. Generic MCP tool schemas, invocation, unified rate limiting and credential injection are not yet intercepted by Runtime V2.

## Secrets

`SecretBroker` provides scoped in-process environment lookups and never serializes secret values in its snapshot.

This is foundation only. Existing OpenCode providers still consume configured environment references directly. Runtime V2 does not yet force every MCP/provider/tool credential through broker-issued ephemeral scoped credentials.

## Sandboxes

Profiles carry a sandbox intent (`safe`, `repo-write`, etc.) so policy and UI can reason about intended scope.

Runtime V2 does not yet enforce these profiles through Docker, namespaces, WSL isolation or a syscall/file/network sandbox. Permission policy remains the actual enforcement layer for current OpenCode actions.

## Project memory and decision log

Persistent project memory and decisions are stored separately from the giant system prompt and are injected into the bounded context envelope.

They currently have authenticated read/write API endpoints. Automatic extraction of architectural decisions from every completed conversation is not implemented yet.

## Observability

Task Center exposes:

- active/queued/paused/completed tasks;
- priority and dependencies;
- route/profile;
- checkpoints;
- per-stage usage;
- artifacts;
- event history;
- basic resource status.

The underlying store also records model success/latency samples.

This is not yet a complete operations dashboard: GPU utilisation, long-term charts, MCP latency/error charts and learned router policies remain future work.

## Event replay limits

The event log is sufficient to inspect and debug task state transitions without re-running the task.

It is **not** yet a deterministic no-cost model-run replay engine. Model responses and every upstream tool response are not captured in a form that can fully emulate a previous OpenCode run.

## API summary

Read endpoints include:

```text
/client-runtime.json
/client-tasks.json
/client-task.json
/client-task-events.json
/client-model-capabilities.json
/client-resource-status.json
/client-repo-index.json
/client-artifact.json
/client-project-memory.json
/client-decisions.json
/client-mcp-gateway.json
```

Mutation endpoints include:

```text
/client-task-control.json
/client-task-create.json
/client-project-memory.json
/client-decisions.json
/client-mailbox.json
/client-speculate.json
/client-artifact.json
```

All are served through the existing authenticated web service.

## Verification

Runtime V2 is covered by `scripts/runtime-smoke.py`, and `scripts/verify.sh` runs it together with the existing web, permission-control, limits and RAG regression checks.

The smoke test covers durable dependencies/checkpoints/events, usage, capability profiles, resource decisions, repository index, semantic diff, artifact range/search, context envelope, failure classification, secret redaction, clean worktree lifecycle, speculative research and MCP metadata facade.
