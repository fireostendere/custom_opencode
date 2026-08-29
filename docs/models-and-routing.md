# Модели и routing

## Пользовательская модель

В UI есть только два execution mode:

```text
Build
Plan
```

Оркестрация выбирается отдельным entry в model picker:

```text
обычная модель
Qwen 3.8 Max · Оркестрированная
```

Оркестрация не является третьим execution mode.

## Build / Plan

`Build` — рабочий режим с доступными выбранному primary agent edit/shell permissions.

`Plan` — read/plan-only: edit/shell запрещены независимо от model profile.

Внутренняя matrix:

```text
обычная модель + Build         → build-direct
обычная модель + Plan          → plan-direct
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
Build + Ollama       → local напрямую, только после ручного выбора пользователем
```

Локальный provider не входит в новые workflow routing/defaults. Workflow server не проверяет GPU/игры, не стартует и не выгружает Ollama и не переключает session на `ollama/*` автоматически.

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

Automatic RAG доступен только orchestrated profile. Direct primary agents не получают automatic subagent/RAG delegation.

## Model picker

Picker поддерживает:

- favorite toggle;
- favorites-first sorting;
- collapsible provider groups;
- отдельную `Бесплатные модели` group;
- hidden search input на mobile;
- special profile entry `Qwen 3.8 Max · Оркестрированная`;
- сохранение direct/orchestrated profile per session в browser state.

Переключение `Build ↔ Plan` не должно выключать orchestrated profile.

Обычная локальная Ollama model остаётся обычным manual model entry. Никакой дополнительный Auto local/cloud entry этой итерацией не добавляется.

## Persistent queue и model state

Если run уже активен, новый submit сохраняется сервером. Когда item доходит до head, queue worker отправляет его в ту же session через уже выбранную для session модель.

Persistent queue:

- не выбирает provider;
- не переключает model;
- не стартует model runtime;
- не выгружает local runtime;
- переживает закрытие/reload PWA;
- позволяет reorder/delete до отправки.

Profile в queue metadata используется только как UX/trace metadata (`direct` или `orchestrated`), а не как механизм автоматического выбора local/cloud provider.

## Project memory

Project settings могут задавать defaults только для безопасного workflow surface:

- `Build / Plan`;
- `Qwen 3.8 Max · Оркестрированная`;
- конкретная поддерживаемая cloud model;
- RAG preference;
- persistent project instructions;
- permission policy.

`auto` и `ollama/*` не принимаются как автоматические project defaults. Если старый experimental feature-state содержит такие значения, server sanitizes их в `inherit`.

Это не мешает пользователю вручную выбрать Ollama в обычном picker.

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

`Qwen 3.8 Max · Оркестрированная` не создаёт фиктивный API model ID: это UI/orchestration policy поверх реального `qwen3.8-max`.

## Бесплатные модели

`Бесплатные модели` определяется сначала по V2 cost metadata, затем ограниченным fallback по known IDs. Free model остаётся direct model и сама по себе не входит в orchestration.

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
- ordinary/orchestrated UI profiles;
- persistent queue surface;
- project settings/policies;
- запрет automatic `auto`/`ollama/*` project defaults;
- отсутствие local lifecycle/routing hooks в новом workflow server;
- safe Git revert containment;
- Max/Flash catalog/config invariants;
- RAG/MCP status при наличии RAG.

Реальный Router E2E в Doctor остаётся отдельным paid smoke.
