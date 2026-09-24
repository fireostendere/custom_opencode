# GPT-6 · Hardware Edition

Native OpenCode V2 profile for engineering with the existing local `kb` RAG and
DipTrace MCP. This adds orchestration to **custom_opencode**, not to the game
server or to the RAG index. It does not modify D&D, reindex the corpus, replace
embeddings, install a new provider, or grant CAD write permissions.

## Status

Implemented: native model-picker alias, scoped context policy, bounded local
Qwen dispatcher, provider request routing, read-only specialist calls, original
image forwarding, deduplication, cancellation and worker telemetry. The new
Node regression suite has **27 passing offline tests**. Those tests exercise
real Request/Response/stream implementations with mocked provider and native
plugin hosts. They are not a real-account or real-board acceptance test.

Not validated here: installation on the user's Windows/WSL host, the live model
catalog/entitlements, OAuth worker requests to each model, live KB/DipTrace
operations, or recognition accuracy and token/latency improvements on actual
boards. Keep this change in its feature branch until those checks pass.

## Roles and routing

| Role | Default model | Use |
|---|---|---|
| Primary designer | Luna XHIGH | Normal engineering work; does not duplicate itself in another worker |
| `design` | Luna XHIGH | A separable circuit block or bounded calculation analysis |
| `vision` | Luna XHIGH with image capability | Selected original images; ambiguous markings remain unknown |
| `pcb_review` | Sol XHIGH | Separate fresh-context review of raw evidence, not of the designer's verdict |
| `critical_design` | Astra, highest advertised effort | Exceptionally difficult design problem |
| `critical_review` | Astra, highest advertised effort | Critical unresolved risk or deepest independent review |
| JEV | Local Qwen 4B | Task classification only; never component selection, pinout or electrical sign-off |

Primary routing is Luna-first. Clear PCB-review requests select Sol. Explicit
Astra/deepest-review, conflicting evidence and listed high-risk domains select
Astra. Other requests may use one short local classification. Local Qwen can
promote a high-confidence PCB-review classification to Sol; it cannot override
the deterministic critical route or decide that a board is safe. These are
routing heuristics, not a complete electrical-risk detector. The primary model
can also request a critical specialist when the difficulty emerges later.

Model IDs and reasoning efforts are resolved from the **actual native catalog**.
The code prefers existing `gpt-6-luna-direct`, `gpt-6-sol-direct` and a catalog
entry identified as Astra. It does not invent an Astra endpoint or pretend that
Sol is Astra. Missing model or unadvertised required effort produces an explicit
error. For `max`, choose the highest advertised `max`, `xhigh`, then `high`.
This checks catalog metadata, not the account's live entitlement.

## Enable on the local installation

Use the normal reviewed feature-branch checkout/install workflow. The existing
`scripts/install.sh` copies top-level plugins and recursively copies `tui/lib`,
so no separate provider credentials, proxy or installer rewrite is necessary.
Preserve the current `.env`, auth and local changes. Do not install over dirty
or divergent work without reconciling it.

After installation and a native process restart, select
**GPT-6 · Hardware Edition** in the model picker. The alias is registered only
when a real Luna entry exists. Keep the ordinary Build agent: there is no new
web/TUI mode. Directly selected models and D&D retain their existing behavior.

`/hardware-status` reports routing, image indices and worker usage without an
LLM call. The same data is available to the model via `hardware_status`.
`hardware_consult` is the only new model-calling tool. The tools are hidden from
non-Hardware contexts; no worker has tools or recursive delegation.

Optional environment settings:

```dotenv
HARDWARE_ORCHESTRATOR=on
# Set off to skip the optional local classifier and keep deterministic routing.
HARDWARE_JEV=on
HARDWARE_QWEN_URL=http://127.0.0.1:11434/api/chat
HARDWARE_QWEN_MODEL=custom-opencode-qwen35-4b-q4km
HARDWARE_QWEN_TIMEOUT_MS=500
# Optional exact existing catalog IDs; not unverified upstream model names:
# HARDWARE_LUNA_MODEL=...
# HARDWARE_SOL_MODEL=...
# HARDWARE_ASTRA_MODEL=...
```

Qwen reuses the resident Ollama service already used for D&D. This plugin does
not download a model or block on starting a cold service. Timeout/offline/invalid
JSON falls back to deterministic routing, followed by a 30-second cooldown.
Only loopback HTTP is accepted; redirects are rejected. Qwen sees at most 1,800
characters of the latest task, not the chat history, pictures or CAD files.
Normal tool continuations reuse the turn decision. Incremental Responses
continuations preserve the existing turn; after a process restart they fail
explicitly rather than guessing a lost route or image list.

## Evidence and image workflow

Keep retrieval in the existing local KB. The main model discovers the relevant
KB/CAD operations and starts with three compact search hits. Expand only when a
needed operating condition, exact package/pinout or conflicting source requires
it. Reuse evidence for the same revision. No new remote LLM is needed merely to
search the local corpus. The plugin does not introduce a second RAG cache or
rewrite existing MCP schemas.

Each specialist receives a fresh packet containing project, board revision,
corpus revision, task, **all user constraints**, source excerpts with locators,
and explicit unknowns. Maximum: 18,000 UTF-8 bytes, eight evidence excerpts.
Oversized packets are rejected, not silently truncated. Source locators and
revision strings are declarations: their presence does not verify a datasheet,
CAD state, DRC result or an evidence-dependent conclusion.

The primary request keeps its original history and attachments. Specialists
receive **only** the packet and selected original `imageIndices`, at most four.
The `vision` role requires an actual image and advertised image capability.
Only current-turn images are available; resend an older image when necessary.
Retention is bounded to eight images/16 MB per session and sixteen sessions;
over-limit images remain in the primary request but are not retained for
specialists, and status reports this. Idle state is discarded after ten minutes.

Use a board overview plus relevant CAD exports/crops, labelled by revision,
layer, orientation and refdes. Native KB/CAD tools remain responsible for reading
structured netlists, ERC/DRC and actual operations. This change does **not** add
an image-to-netlist engine, automatic cropping, OCR training or a new vision
model. Better evidence delivery is implemented; better recognition accuracy
still needs a paired evaluation. A photograph cannot prove hidden traces,
electrical continuity, clearance on hidden layers or manufacturing readiness.

## Budget, transport and safety boundaries

A specialist uses the same native provider endpoint and authentication as its
parent, but a new request with no transcript, conversation ID, previous-response
ID, parent request ID or tools. Credentials remain in bounded memory and are
never included in receipts, logs or files. No model-supplied provider URL is
accepted. Worker requests do not bypass CAD authorization because workers
cannot execute tools; the main host still owns native/MCP permissions.

There are at most four consultations per observed user turn and two concurrent
workers. Identical role + revision-scoped packet + selected images + model
requests share one result/promise. Failures are cached too: an automatic retry
cannot silently buy the same failed call again. Caches are isolated by session
and cleared for a new turn. Calls time out after 120 seconds, or 240 for Astra;
a superseding turn, manual model switch, host cancellation signal or plugin
shutdown aborts pending workers. An incomplete/truncated provider result is
never returned as a completed review. These limits constrain calls and retained
output, **not a guaranteed dollar or reasoning-token ceiling**.

No hidden `Fast`/Priority promise: the plugin follows the D&D OAuth behavior and
removes unsupported `service_tier` outside the official API host. Worker
receipts report the actual tier when the provider returns it. API-key requests
may retain their existing requested tier; the plugin does not buy Priority by
itself.

Worker telemetry includes model, effort, role, packet bytes, image count,
latency, streaming TTFT, and provider-supplied usage (including cached/reasoning
fields when supplied). Missing usage stays null. The parent is tracked by the
existing native runtime. Specialist HTTP calls currently use this plugin's own
bounded dispatch and telemetry, **not Runtime V3's durable task ledger/global
budget or native provider retry loop**. Do not interpret parent-only billing
statistics as the total cost. No dollar estimate is fabricated.

The hardware context suppresses the project's generic automatic coding,
Ponytail, plan and automatic runtime-RAG additions; native/project/user
instructions remain. MCP exposure keeps KB/CAD/discovery and read/code-mode
entry points. It is context reduction, not a replacement sandbox or a grant of
new permissions. DipTrace's installed read-only policy is not changed.

## Verification

```bash
node --test scripts/hardware-orchestrator-regression.mjs
node scripts/context-lanes-regression.mjs
```

The dedicated workflow runs both the new offline suite and existing context
lane regression. Before accepting the branch, verify the real model picker in
web and TUI; one Luna response, one fresh Sol review, one Astra call, one real
image and one KB/DipTrace read; cancellation; offline Qwen; and missing Astra.

For a performance/quality comparison, hold the task, board revision, CAD/export,
RAG corpus and model access constant. Compare direct Luna XHIGH with Hardware
Edition on ordinary design, PCB review, ambiguous markings and conflicting
part/package evidence. Record total calls and total input/output/cached/
reasoning tokens **across all models**, TTFT and end-to-end latency; score
critical-defect recall, false positives, source/pin/value accuracy and honest
unknowns against expert-reviewed ground truth. Test multiple runs. Escalation
and independent review can cost more than a single direct response; savings
must be measured, not inferred from the word orchestration.
