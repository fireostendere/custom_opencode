# Cossacks script-advisor and learning infrastructure

The optional `cossacks_lab` native tool exposes **offline read-only** status,
script-advice input inspection and outcome-labelled dataset audits. It registers
only in a project containing `scripts/run_script_advisor.py`, or at the host's
explicit `COSSACKS_PROJECT_ROOT`. `COSSACKS_PYTHON` selects its trusted Python
executable. Put these non-secret settings in the private user configuration;
use the normal installer instead of editing installed config files.

The companion bot repository supplies the versioned script-advice contract and
CLI. The tool accepts only fixed actions and project-relative artifacts that
resolve inside that project's `data/derived`. It checks native permissions,
uses an argument array without a shell, bounds output and supports cancellation.
It has no game command, apply, prompt-editing, training or game-launch action.
Austria's evolving policy and existing D&D/engineering profiles are unchanged.

Supported agent tool inputs:

```json
{"action":"status"}
{"action":"review-input","artifact":"data/derived/advisor-example/chase.json"}
{"action":"dataset-audit","artifact":"data/derived/advisor-labels.jsonl"}
```

## Autonomous Decisions worker

`scripts/cossacks-advisor.mjs` is a separate bounded JSONL worker sharing
`decisions.js`'s actual HTTPS implementation. A trusted autonomous game runtime
starts it before a match; no OpenCode conversation, model-generated tools,
general agent loop or new HTTP service drives it. Each line contains an SHA-256
request ID plus the existing `input`/`questions` shape. Each reply echoes the ID
and a typed result or a sanitized failure. It never observes or writes the game.

The worker uses `OPENAI_DECISIONS_API_KEY` through `serviceSetting`, just like
the native Decisions tool. Its default is 64 requests (maximum 256), a complete
32 KiB request cap and a 4-second network timeout. Duplicate IDs do not dispatch.
Provider/model/usage/format failures suspend the lane; no automatic retries or
fresh worker replacement may erase uncertainty during a match. Actual usage is
returned when known. Local cancellation/exit does not prove remote termination
or zero charges. The worker has its own bounded match lifetime; it does not
claim integration with the interactive root session's request ledger.

The native Decisions tool retains its original permission and runtime-ledger
behavior. Its shared endpoint is documented in the
[official Decisions guide](https://developers.openai.com/api/docs/guides/decisions).

## Laya, RAG and training

The bot companion's `AsyncScriptAdvisor` can use either the worker or a local
Laya script-advice artifact. Both receive the same compact state and numbered
controller candidates. Examples include ending fruitless pursuit or retaining
screening pressure while paying for an available next-tier transition. Exact
unit production, ownership, costs and commands remain controller responsibilities.

The existing game-specific qualified RAG path supplies bounded reviewed
excerpts. Generic engineering/D&D search results and the historical game archive
are not automatically live evidence. Local-prompt rights do not permit sending
an excerpt to OpenAI. Missing RAG does not stop the baseline.

Research fitting/evaluation uses the companion's documented CLI between matches.
Records keep decision-time input separate from outcome values and split whole
matches/scenario families. Model suggestions are not ground-truth labels. The
initial training format is RAG-off; preserve exact conditioned input before
extending it to RAG-on traces. Research weights never activate themselves.

This prepares transport and offline tools, not native field/executor binding,
model quality or tournament qualification. No live paid request, game launch or
GPU training is part of the model-free regressions:

```sh
node scripts/decisions-regression.mjs
node scripts/cossacks-regression.mjs
bash scripts/verify.sh
```
