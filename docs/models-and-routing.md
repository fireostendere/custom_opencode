# Модели и routing

## Пользовательская модель выполнения

Web UI поддерживает `Build` и `Plan`. Модель или server profile выбирается в model picker, а режим выполнения переключается отдельно.

Есть два принципиально разных пути:

1. обычная конкретная модель — direct/manual selection;
2. server profile Runtime V2/V3 — role-based orchestration policy.

`plan`/`plan-direct` остаются native upstream agent IDs. Для обычной модели UI предпочитает `build-direct`/`plan-direct`, если compatibility agents доступны, и иначе использует native `build`/`plan`; для orchestration alias используются native `build`/`plan`. Provider/model/variant при смене режима сохраняются.

## Direct/manual model

Обычная выбранная модель работает напрямую:

- выбранный provider/model сохраняется;
- Runtime не имеет права подменить его другой моделью;
- orchestration policy не включается сама по себе;
- automatic reader/reviewer delegation не добавляется.

Это главный invariant direct path: manual selection всегда авторитетна.

## Provider-locked role stack

Основной orchestration stack:

| Role | Model | Provider | Default effort |
|---|---|---|---|
| planner | `qwen3.8-max` | `bailian-cli` | high |
| builder | `qwen3.7-plus` | `bailian-cli` | medium |
| reader | `qwen3.8-flash` | `bailian-cli` | low |
| reviewer | `deepseek-v4-pro-0813` | `bailian-cli` | high |
| long horizon | `glm-5.2` | `bailian-cli` | medium/effective provider level |

Qwen, DeepSeek и GLM в этих profiles используются именно через Alibaba Cloud/Bailian. Runtime не должен незаметно подменять их OpenRouter, standalone DeepSeek/Zhipu или другим gateway.

OpenAI direct models остаются на существующем официальном OpenAI provider.

## Server profiles

`app/model_registry.py` предоставляет только актуальные profiles:

| Profile | Основной путь | Назначение |
|---|---|---|
| `direct` | selected provider/model | ручной direct path |
| `fast` | Qwen 3.8 Flash / low | быстрые и механические задачи |
| `build` | Qwen 3.7 Plus / medium | обычная разработка |
| `architect` | Max planner + Flash reader + Plus builder | большие архитектурные задачи |
| `critical` | Architect stack + DeepSeek reviewer | high-risk production work |
| `research` | Max + Flash research + DeepSeek critic | research/synthesis |
| `long-horizon` | Max + GLM + Flash + DeepSeek | длинная автономная работа |

Старый adaptive/device router больше не является частью model routing.

## Routing rule

Routing теперь детерминированный:

```text
direct
  -> оставить ровно выбранный provider/model

fast
  -> Alibaba Qwen 3.8 Flash

build
  -> Alibaba Qwen 3.7 Plus

architect / critical / research / long-horizon
  -> provider-locked role stack согласно profile
```

Нагрузка хоста, GPU, запущенные игры или доступность другого inference endpoint не меняют model route.

## Effort routing

Effort и выбор модели — разные оси.

Canonical levels:

```text
auto
minimal
low
medium
high
max
```

`max` означает «максимальный реально поддерживаемый effort выбранной моделью/provider», а не обязательную literal строку `max` в API.

Обычный coding escalation:

```text
Qwen 3.7 Plus / medium
        ↓ meaningful failed solution attempt
Qwen 3.7 Plus / high
        ↓ repeated stall / architecture contradiction
Qwen 3.8 Max / high replanning
        ↓ exceptional/critical reasoning only
Qwen 3.8 Max / max
```

Один неудачный shell command, typo, missing file или transient tool error не считается failed reasoning attempt.

## Reader

`fast-reader` использует Alibaba Qwen 3.8 Flash / low и является read-only bounded worker.

Он нужен для:

- repository-wide search;
- many-file inspection;
- large logs/docs/configs;
- dependency/call-site discovery;
- RAG evidence gathering;
- точного extraction;
- vision/screenshot analysis, когда это полезно.

Reader возвращает только bounded handoff:

```text
summary
relevant files/symbols/ranges
evidence/provenance
dependencies
uncertainties
recommended next actions
```

Полный transcript reader не копируется в parent context.

## Builder

Обычная работа выполняется `role-builder` на Qwen 3.7 Plus / medium.

При первом реальном провале гипотезы используется `role-builder-high`. `role-builder-max` зарезервирован для исключительных случаев и не должен становиться нормальным default.

Builder возвращает checkpoint:

```text
completed
changed files
tests/results
failures/blockers
remaining work
architecture deviations
```

## Planner

Qwen 3.8 Max отвечает за планирование, архитектуру и escalation.

Он не должен контролировать каждый `grep`, `read`, `edit`, `shell` или `pytest`. После выдачи bounded work package обычная реализация остаётся у builder.

## Independent reviewer

`role-reviewer` / `role-reviewer-max` использует Alibaba DeepSeek V4 Pro 0813.

Reviewer read-only и получает:

- original task;
- accepted plan;
- diff/changed files;
- test results;
- known limitations;
- релевантные evidence.

Builder hidden reasoning/full transcript reviewer не получает. Findings возвращаются builder для fixes. Автоматический review/fix loop должен быть ограничен.

## Long horizon

GLM 5.2 — отдельный executor для действительно длинных bounded work packages. Это не default builder для обычного PR.

## Model picker

Picker может показывать обычные provider models и server profiles. Dedicated
`Qwen 3.8 Max · Orchestrated` и `GPT-5.6 Sol · Orchestrated` catalog aliases
используются только как trigger для orchestration prompt/plugin и указывают на
реальные модели провайдеров. Обычные Qwen/SOL/Terra/Luna остаются direct.

Orchestration выбирается моделью/profile, а `Build` или `Plan` определяет primary execution mode независимо от него.

## Queue и task model state

Runtime task хранит profile. При dispatch profile разрешается в provider-pinned model route.

Direct task сохраняет выбранную модель. Queue сама по себе не является причиной смены provider/model.

## Context / compaction

Runtime V3 использует native OpenCode durable compaction.

Custom preflight budget model-aware: он берёт реальный context limit активной модели и `contextPolicy.targetRatio`. Повторный custom compact требует meaningful context growth и не должен спамиться по короткому fixed cooldown.

Изменение effort или role transition само по себе compaction не запускает.

## Alibaba model catalog

Provider config содержит, среди прочего:

```text
qwen3.8-max
qwen3.8-flash
qwen3.7-max
qwen3.7-plus
qwen3.6-flash
glm-5.2
deepseek-v4-pro
deepseek-v4-pro-0813
deepseek-v4-flash-0731
```

`qwen3.8-max-preview` остаётся compatibility ID старых sessions. Он не является routing profile.

## Проверка

Zero-token regression должна фиксировать минимум:

- direct model preservation;
- актуальный profile set;
- Alibaba provider lock;
- Qwen 3.8 Flash reader;
- Plus builder medium/high/max escalation;
- Max planner high/max escalation;
- DeepSeek reviewer provider/effort;
- отсутствие retired device-routing configuration;
- model-aware compaction;
- RAG/MCP invariants;
- permission/sandbox boundaries.

Основные команды:

```bash
python3 scripts/model-routing-effort-smoke.py
bash scripts/verify-runtime-v3.sh
bash scripts/regression.sh
```
