# DnD Edition: Escape, project MCP and measured turn latency

Measured on 2026-09-22 with native OpenCode v0.0.0-beta-18743. Custom base:
`6054271`; ODM base: `547034d0`. The model label was `gpt-5.6-dnd-edition`.

| Measurement | Working MCP baseline | Final |
| --- | ---: | ---: |
| Complete local turn | 100,888 ms | 54,122 ms |
| Assistant steps | 13 | 7 |
| Tool calls / errors | 12 / 4 | 6 / 0 |
| Input tokens, including cache reads | 183,460 | 87,229 |
| Uncached input tokens | 40,100 | 28,349 |
| Output / reasoning tokens | 1,338 / 2,267 | 1,191 / 1,126 |

One independently seeded campaign per configuration: one fighter, twelve transcript
messages, inspect a chest, server perception DC 12, then committed narration.
This is real native inference through MCP into ODM's authenticated control route
and encrypted SQLite engine. It is not a browser benchmark or p50/p95 estimate.
Provider caching and random dice differed. The original broken MCP endpoint
could not complete a turn; the baseline starts after repairing connectivity.
Intermediate run: 66,828 ms, 128,782 input tokens including cache, three tool errors.

The fixes remove waits for ledger persistence during stream cancellation,
preserve native project MCP overrides, expose project `dnd_knowledge_*` read tools,
initialize DnD discovery correctly, preload the two mandatory game skills, and
clarify operation-specific arguments and post-write reads. Optional Qwen startup
runs in the background in auto mode. Transport failures suppress retries for 30 s:
the live private route measured 1,817.81 ms, then 1.70 and 1.53 ms.

`scripts/native-interrupt-live.py` used a real TUI/PTY, isolated native service and
local streaming provider: one Escape reached interrupted state in approximately
55 ms and disconnected the provider. No paid inference in this check. The separate
request-budget regression verifies that a pending ledger write cannot hold up
cancellation. Interrupt does not roll back an already committed game action.

Relevant checks passed: request-budget, config-manager, context-lanes,
dnd-super-orchestrator, dnd-edition profile/UI, MCP profiles, TUI, web smoke,
server-runtime-guard and runtime smoke. ODM's tool-contract, narrator-only and
narrator-control checks passed using Linux-compatible dependencies.

The ODM `astra` branch contains project setup, the disposable campaign server,
`scripts/benchmark-opencode.py`, reproduction instructions in
`docs/opencode-dnd-2026-09-22.md`, and sanitized measurements in
`docs/performance/opencode-dnd-2026-09-22.json`. Production ODM was not redeployed.

## Cache and branch integration followup

Native OpenCode supplies a stable session-derived `promptCacheKey`; the DnD
request hook preserves it. The DnD system prefix is stable and excludes generic
runtime snapshots. Recorded cache reads were 58,880 / 87,229 total input tokens
(67.5% including two cold requests); warmed individual requests reached 80–86%.
This confirms cache reuse, not a maximum possible speedup. The first requests
also acquire MCP tools, changing the advertised schema prefix.

OpenAI documents automatic prefix caching and stable history/tool definitions:
https://developers.openai.com/api/docs/guides/prompt-caching
The application uses the installed native transport; no unverified cache-retention
or explicit-breakpoint fields were injected into its authenticated endpoint.

All 16 local/origin branch tips were included in the integration candidate.
Five historical feature branches had identical patches already cherry-picked;
their ancestry was merged without replacing later fixes. The full installer
verifier passed before promotion to main. ODM's companion integration includes
sticky referee sessions scoped to one input, not indefinite cross-turn reuse.
