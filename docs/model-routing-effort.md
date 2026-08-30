# Role routing and reasoning effort

This document describes the provider-locked role stack used by the custom OpenCode V2 orchestration path.

## Provider invariant

The orchestration stack uses the existing Alibaba Cloud Token Plan provider ID `bailian-cli`.

| Role | Model | Provider |
| --- | --- | --- |
| planner | `qwen3.8-max` | `bailian-cli` |
| builder | `qwen3.7-plus` | `bailian-cli` |
| reader | `qwen3.8-flash` | `bailian-cli` |
| reviewer | `deepseek-v4-pro-0813` | `bailian-cli` |
| long horizon | `glm-5.2` | `bailian-cli` |

These roles must not silently fall back to OpenRouter, standalone DeepSeek, standalone Zhipu, or another gateway. OpenAI models remain on the existing official OpenAI provider when the user selects them directly.

Canonical environment overrides:

```bash
OPENCODE_PLANNER_MODEL=bailian-cli/qwen3.8-max
OPENCODE_BUILDER_MODEL=bailian-cli/qwen3.7-plus
OPENCODE_READER_MODEL=bailian-cli/qwen3.8-flash
OPENCODE_REVIEW_MODEL=bailian-cli/deepseek-v4-pro-0813
OPENCODE_LONG_HORIZON_MODEL=bailian-cli/glm-5.2
```

## Canonical effort

Runtime policy uses these provider-neutral labels:

`auto`, `minimal`, `low`, `medium`, `high`, `max`.

`max` is a semantic request for the strongest reasoning mode supported by the selected model/provider. It is not blindly forwarded as a literal API value.

Current Alibaba mappings used by the registry/config:

| Model | canonical low | canonical medium | canonical high | canonical max |
| --- | --- | --- | --- | --- |
| Qwen 3.8 Max / Flash | `low` | `medium` | `xhigh` | `xhigh` |
| Qwen 3.7 Plus | thinking 4096 | thinking 16384 | thinking 65536 | thinking 262144 |
| DeepSeek V4 Pro 0813 | provider `low` when explicitly selected; role default `high` | maps to high policy | `high` | `max` |
| GLM 5.2 | effective high | effective high | `high` | `max` |

Qwen 3.7 Plus intermediate thinking budgets are local routing policy. Its Alibaba-documented maximum thinking budget is 262144 tokens.

OpenCode V2 custom variants are used for concrete agent effort selection. Examples:

```text
bailian-cli/qwen3.8-flash#low
bailian-cli/qwen3.7-plus#medium
bailian-cli/qwen3.7-plus#high
bailian-cli/qwen3.7-plus#max
bailian-cli/deepseek-v4-pro-0813#high
bailian-cli/deepseek-v4-pro-0813#max
bailian-cli/glm-5.2#high
bailian-cli/glm-5.2#max
```

## Default orchestration

Normal coding should not start a swarm.

```text
normal implementation
  -> Qwen 3.7 Plus / medium

meaningful failed solution attempt
  -> Qwen 3.7 Plus / high

repeated stall / architectural contradiction
  -> Qwen 3.8 Max / high replanning

exceptional or critical reasoning
  -> Qwen 3.8 Max / canonical max
```

Broad mechanical reading uses Qwen 3.8 Flash / low and returns bounded findings rather than a full transcript.

Critical review uses Alibaba DeepSeek V4 Pro 0813 / max and is read-only. The reviewer receives the task, accepted plan, diff/changed files, test results and known limitations, not the builder's hidden reasoning transcript.

## Configured subagents

- `fast-reader`: Qwen 3.8 Flash / low, read-only.
- `role-builder`: Qwen 3.7 Plus / medium.
- `role-builder-high`: Qwen 3.7 Plus / high.
- `role-builder-max`: Qwen 3.7 Plus / max.
- `role-reviewer`: DeepSeek V4 Pro 0813 / high, read-only.
- `role-reviewer-max`: DeepSeek V4 Pro 0813 / max, read-only.
- `role-long-horizon`: GLM 5.2 / effective high.
- `role-long-horizon-max`: GLM 5.2 / max.

The `qwen3.8-orchestrated` catalog entry remains a friendly alias for the primary Qwen 3.8 Max session. The `orchestrated-qwen` plugin injects the orchestration policy only for that alias, so ordinary direct Qwen 3.8 Max sessions remain native/direct.

## Handoff discipline

Reader handoff: summary, files, symbols/ranges, evidence, dependencies, uncertainties, recommended next actions.

Builder checkpoint: completed work, changed files, tests, failures, remaining work, architecture deviations.

Reviewer result: severity, finding, evidence/file/range, recommendation, confidence.

Full subagent transcripts should not be copied into the primary context. Large evidence should be stored as artifacts where the runtime supports it.

## Regression

Run:

```bash
python3 scripts/model-routing-effort-smoke.py
bash scripts/regression.sh
```

The focused smoke verifies provider lock, role defaults, canonical effort translation, OpenCode V2 model variants, role agent refs, and the orchestrator policy contract.
