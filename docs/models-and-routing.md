# Модели и routing

## Пользовательская модель

В UI есть только два execution mode:

```text
Build
Plan
```

Routing выбирается отдельным entry в model picker. Сейчас есть три типа profile:

```text
обычная модель
Qwen 3.8 Max · Оркестрированная
Auto · local/cloud
```

Ни orchestration, ни Auto не являются третьим/четвёртым execution mode.

## Build / Plan

`Build` — рабочий режим с доступными выбранному primary agent edit/shell permissions.

`Plan` — read/plan-only: edit/shell запрещены независимо от model profile.

Внутренняя matrix:

```text
обычная модель + Build         → build-direct
обычная модель + Plan          → plan-direct
Auto + Build                   → build-direct
Auto + Plan                    → plan-direct
Оркестрированная + Build       → build
Оркестрированная + Plan        → plan
```

`build`, `plan`, `build-direct`, `plan-direct` — implementation detail.

## Direct models

Любая обычная модель из picker работает напрямую:

- orchestrator prompt отсутствует;
- automatic fast-reader запрещён;
- automatic RAG tools запрещены.

Например:

```text
Build + Qwen3.8 Max  → Qwen3.8 Max напрямую
Plan + Qwen3.8 Flash → Qwen3.8 Flash read-only
Build + Ollama       → local напрямую
```

## Оркестрированная модель

`Qwen 3.8 Max · Оркестрированная` использует underlying `bailian-cli/qwen3.8-max`, но разрешает bounded delegation:

```text
Qwen 3.8 Max
      ↓ если bounded read/delegation полезны
fast-reader → bailian-cli/qwen3.6-flash
      ↓ при corpus-relevant engineering lookup
kb MCP → mcp-rag
```

`fast-reader` read-only: repository exploration, logs, точечный lookup и ограниченный RAG evidence. Финальное reasoning/edit/security решение остаётся у Max.

Automatic RAG доступен только orchestrated profile. Direct и Auto primary agents не получают automatic subagent/RAG delegation.

## Auto · local/cloud

`Auto` — явный profile в model picker. Он может также быть сохранён default конкретного project.

Он сохраняет direct agent policy, но перед каждым submit выбирает underlying model:

```text
Ollama доступен + ПК свободен → project localModel
иначе                        → project cloudModel
```

Default policy:

```text
localModel      = ollama/qwen3.8:27b
cloudModel      = bailian-cli/qwen3.8-flash
gpuBusyPercent  = 35
```

В Project settings эти значения можно менять.

### Что считается busy

Backend проверяет:

- known game process;
- GPU utilization >= project threshold.

`OPENCODE_AUTO_GAME_PROCESSES` задаёт semicolon-separated process fragments. Default включает `dota2`, `cs2`, Wine/Proton helpers.

Для WSL detector дополнительно читает Windows process list через `powershell.exe` и `tasklist.exe`. Поэтому Windows Dota/CS может переключить OpenCode, запущенный в WSL, на cloud.

Для AMD GPU приоритетно читается `/sys/class/drm/card*/device/gpu_busy_percent`, затем используются ROCm/AMD-SMI fallbacks. NVIDIA использует существующий `nvidia-smi` path.

При busy state backend делает best-effort Ollama unload через `keep_alive: 0`, чтобы VRAM быстрее освободилась игре.

### Что Auto не делает

- не переключает обычные model entries;
- не включает local routing скрытно;
- не даёт local model subagent/RAG permissions;
- если Ollama недоступен, не ломает задачу — выбирается cloud fallback.

`OPENCODE_LOCAL_AUTO_START` остаётся отдельной host policy для lazy local-router plugin. Если local runtime должен стартовать по model request, настройте router/start script; иначе Auto использует local только когда runtime уже доступен.

## Model picker

Picker поддерживает:

- favorite toggle;
- favorites-first sorting;
- collapsible provider groups;
- отдельную `Бесплатные модели` group;
- hidden search input на mobile;
- special profile entries `Оркестрированная` и `Auto`;
- сохранение выбранного profile per session в browser state.

Переключение `Build ↔ Plan` не должно выключать выбранный special profile.

## Persistent queue и routing

Если run уже активен, новый submit не меняет текущую model. Prompt сохраняется сервером вместе с profile, выбранным в момент постановки в queue.

Когда queued item доходит до head:

- `direct` использует session model;
- `orchestrated` использует сохранённую orchestrated agent/profile state;
- `auto` повторно оценивает machine load прямо перед отправкой.

Это важно: queued Auto prompt, созданный до запуска игры, всё равно уйдёт в cloud, если к моменту его выполнения ПК уже занят.

## Project memory

Project settings могут задавать default profile/model для новых/пустых sessions. Existing session при открытии не переписывается автоматически.

Persistent project instructions отправляются через отдельное `system` field message request; это не user-visible prefix.

## Alibaba model catalog

Provider config содержит:

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

`qwen3.8-max-preview` — compatibility ID старых sessions.

Special profiles не создают фиктивных API model IDs: они являются UI/routing policy поверх реальных models.

## Бесплатные модели

`Бесплатные модели` определяется сначала по V2 cost metadata, затем ограниченным fallback по known IDs. Free model остаётся direct model и сама по себе не входит в Auto/orchestration.

## Permissions fast-reader

Deny-first policy:

```text
* → deny
read/glob/grep/list/lsp → allow
kb_knowledge_search/get/sources/status → allow
edit/shell/ingest/external dirs → deny, кроме явно разрешённых исключений
```

`.env` и `.env.*` запрещены read-only worker; `.env.example` разрешён как публичная схема.

## Проверка без платного inference

Zero-token verifier проверяет:

- Build/Plan mapping;
- ordinary/orchestrated/Auto UI profiles;
- persistent queue surface;
- project settings/policies;
- Auto local/cloud routing на synthetic load;
- safe Git revert containment;
- Max/Flash catalog/config invariants;
- RAG/MCP status при наличии RAG.

Реальный Router E2E в Doctor остаётся отдельным paid smoke.
