# MCP profiles

The optional [Universal Tool Fabric](tool-fabric.md) adds a workspace-scoped
`fabric` namespace with five stable discovery/execution tools. Include it in a
profile to expose operator-selected private layers; existing upstreams are not migrated.

## Automatic connection recovery

`mcp-reconnect.js` runs inside the managed background OpenCode service, independently
of the web UI. It checks native in-process MCP status every two seconds and retries
transient connection failures up to three times, with 2/10/30-second backoffs.
Sixty seconds of observed healthy connection resets the budget; short flaps do not.
Disabled, removed and authentication-failed servers are not re-enabled. After the
budget is exhausted, use the native manual reconnect control. Existing tool calls
are never replayed: recovery restores the catalog for subsequent model requests.
Logs use the `mcp automatic recovery` marker and contain server names/attempts/status,
not credentials or tool arguments. Standalone/unmanaged servers are not controlled.

Checks: `node scripts/mcp-reconnect-regression.mjs` and
`python3 scripts/mcp-reconnect-live.py` (isolated native service, no inference).

## Implementation and acceptance status

Implementation is in progress. Native-dialog mocks exercise the real wizard and
configuration manager, but are **not** live TUI acceptance. The required installation
of Serena, Context7, Playwright, Chrome DevTools and Semgrep through the actual V2
wizard, profile switching, real tool calls and restart acceptance remain pending.
Do not treat this branch as release-ready until those gates have evidence.

## Configuration ownership and migration

`config/plugins/config-manager.js` remains the only writer. On first load without
`registry-v2`, it reads `registry-v1`, preserves existing fields and writes version 2.
The old key remains an untouched recovery copy. Subsequent loads use version 2;
an unsupported newer version is rejected rather than overwritten. Existing provider,
model, MCP, skill and orchestration commands retain their JSON interfaces.

The registry adds `mcpProfiles` and `mcpSettings`. A profile is ordinary data:

```json
{
  "id": "frontend",
  "name": "Frontend",
  "mcp": ["docs", "browser"],
  "risk": "normal",
  "keywords": ["frontend", "css"],
  "agents": ["frontend-builder"]
}
```

Duplicate members are normalized. Missing and disabled members appear in diagnostics
and never enable tools. Removing an MCP preserves dangling profile references so the
user can repair them deliberately. `auto` and `all` are reserved, case-insensitively.

## TUI workflow

- `/add` opens the configuration type selector.
- `/add mcp` and `/addmcp` create/update an MCP. Enter an existing ID to prefill its
  command/URL and preserve additional configuration fields. Profile membership is
  selected before saving, in the same registry transaction.
- `/add mcp-profile` and `/addmcpprofile` create/edit profiles. Pick an existing
  profile, or supply a new ID, then edit its name, members, risk and routing rules.
- Select a checkbox row to toggle it; select **Done** to continue. Escape cancels.
- Every wizard ends with a save confirmation. Cancelling writes no configuration.
- `/configure` groups add/update, profile selection, exposure/status and removal.
- `/mcp-profile` opens runtime selection. The palette also has **MCP profile: select**.
  Auto and All surround the dynamically registered profiles.

The server command is awaited using V2's `text` field. Read-only registry queries
use correlated native synthetic receipts; these receipts are removed from outgoing
model context. The TUI does not maintain another durable registry. Compatibility
panel command IDs remain callable, but their duplicate palette rows are hidden.

## Routing and worker isolation

The default is Auto. Explicit session selection is inherited by descendants and
takes precedence over automatic routing. An optional per-agent selection can be set
with `/mcp-profile {"mode":"frontend","agent":"frontend-builder"}`. A default
for future sessions can be set through the selector or with `scope: "default"`.
The selector also configures Auto's fallback (`scope: "fallback"`), which must be
All or a normal profile. Selections persist in `mcpSettings`.

Auto first checks profile `agents`, then matches task words against `keywords`.
An unambiguous highest score wins. Ambiguous tasks use `mcpSettings.fallback`, or
`core` when profiles exist. With no profiles, Auto preserves the legacy All behavior.
A missing fallback fails closed for MCP and produces a diagnostic warning.
Elevated profiles are not selected from task keywords; explicitly assigned agents
or a manual choice may select them. This metadata does not grant permissions.

Starter routing suggestions for core/frontend/backend/security/embedded/
embedded-debug/lab/pcb live in the pure policy module. They contain no MCP server
bindings and are copied into editable profile data by the wizard. Skills are separate.

The existing TUI orchestration plugin supplies model-specific instructions; it does
not expose a reusable cheap classifier API. This implementation therefore uses a
deterministic fallback and makes no additional inference request for routing.

## Native tool context and Code Mode limitation

The installed beta-18743 exposes mutable `session.hook("context").tools`. Its
request builder constructs the provider tool definitions from that object **after**
the hook. Filtering is per model request, using session/agent identity; switching
one worker never changes a global active MCP set.

Native Code Mode constructs a shared catalog earlier, outside this hook. When any
profiles exist, the MCP transform exposes servers as direct native tools
(`codemode: false`) so inactive definitions can actually be removed. Stored Code
Mode preferences are preserved and resume when the last profile is removed. This
is an explicit compatibility tradeoff, not per-worker Code Mode isolation.

Connections can remain open across profiles. Profile activation reduces model tool
definitions, not server process count. Existing native permissions still apply.
Requests already in flight retain the definitions with which they were dispatched.

## Evidence and tests

`/configure` → **MCP tool exposure / status** shows the last observed request's
profile, active servers, exposed/excluded tool counts, warnings and connection state.
No request means no measured count, not an invented success result. `/managed`
also includes the latest observation.

For provider-wire evidence, set `OPENCODE_MCP_PROFILE_EVIDENCE` to a writable JSONL
file before starting OpenCode. The native HTTP request hook records only timestamp,
session/agent/profile IDs and outgoing tool names. It never records prompts,
arguments, headers or credentials. This instrumentation requires an actual HTTP
model request; context-hook unit tests do not establish wire-level acceptance.

```sh
node scripts/mcp-profiles-regression.mjs
node scripts/config-manager-regression.mjs
node scripts/tui-add-wizard-regression.mjs
node scripts/wizard-validation-smoke.mjs
node scripts/panel-submit-regression.mjs
node scripts/tui-regression.mjs
bash scripts/regression.sh
```

The profile regression covers v1 migration, profile CRUD, duplicate/missing/disabled
members, manual/Auto policy, parallel request filtering, membership updates and
restart persistence with mocked native APIs. The wizard regression additionally
covers profile creation/editing, MCP membership removal and final/selector Cancel.

At the first full-regression run on this branch, `scripts/web-smoke.mjs:243` fails
on its existing Activity markup assertion before the remaining full suite runs.
This must be resolved or independently documented against the base revision before
declaring the release green.

Native API references: [context hooks](https://opencode.ai/v2/docs/build/plugins),
[MCP naming and Code Mode](https://opencode.ai/v2/docs/mcp-servers/).
