# Модели и routing

## Пользовательская модель

В UI есть только два режима выполнения:

```text
Build
Plan
```

Оркестрация не является третьим mode. Она выбирается в model picker как специальный model profile:

```text
Qwen 3.8 Max · Оркестрированная
```

Обычные модели из picker работают напрямую.

## Build

`Build` — обычный рабочий режим. Выбранная модель может выполнять задачу с доступными ей edit/shell permissions.

При выборе обычной модели используется внутренний `build-direct` agent:

- выбранная модель работает напрямую;
- orchestrator system prompt отсутствует;
- automatic `fast-reader` запрещён;
- automatic RAG tools запрещены.

Например:

```text
Build + GPT-5.6 Sol      → GPT-5.6 Sol напрямую
Build + Qwen3.8 Max      → Qwen3.8 Max напрямую
Build + local Ollama     → локальная модель напрямую
```

## Plan

`Plan` — read/plan-only режим. `edit` и `shell` запрещены независимо от выбранного model profile.

Обычная модель в Plan использует внутренний `plan-direct` agent:

```text
Plan + Qwen3.8 Flash → Qwen3.8 Flash, без edit/shell
```

## Оркестрированная модель

При выборе:

```text
Qwen 3.8 Max · Оркестрированная
```

используется тот же underlying API model:

```text
bailian-cli/qwen3.8-max
```

но Qwen Max получает orchestrator policy и может при необходимости делегировать bounded read-only работу.

Матрица внутренних agent IDs:

```text
обычная модель + Build         → build-direct
обычная модель + Plan          → plan-direct
Оркестрированная + Build       → build
Оркестрированная + Plan        → plan
```

`build`, `plan`, `build-direct`, `plan-direct` — backend implementation detail. Пользователь не должен выбирать или видеть их как четыре режима.

Схема orchestration:

```text
Qwen 3.8 Max
      ↓ если bounded read/delegation реально полезны
fast-reader → bailian-cli/qwen3.6-flash
      ↓ если нужен engineering corpus evidence
kb MCP → mcp-rag
```

`fast-reader` используется для дешёвых read-only задач:

- найти файл/символ;
- прочитать небольшой набор файлов;
- разобрать лог;
- сделать точный repository lookup;
- получить ограниченное RAG evidence;
- вернуть короткое factual summary primary agent.

Он специально не получает edit/shell права.

Qwen 3.8 Max остаётся владельцем:

- пользовательской задачи;
- planning/reasoning;
- edit/shell операций в Build;
- архитектурных решений;
- security-sensitive решений;
- синтеза нескольких источников;
- финальной проверки/ответа.

Delegation — опциональная оптимизация, а не обязательный этап каждого prompt.

Переключение `Build ↔ Plan` сохраняет выбранный model profile: обычная модель остаётся обычной, `Qwen 3.8 Max · Оркестрированная` остаётся orchestrated.

## Model picker

Model picker является единственным местом включения orchestration.

Он поддерживает:

- favorite toggle `★/☆` у каждой обычной модели;
- нажатие `★/☆` не выбирает модель;
- сортировку внутри provider: favorites → выбранная модель → остальные по имени;
- provider groups с избранным поднимаются выше provider groups без избранного;
- остальные provider groups сортируются по имени;
- collapsible provider groups;
- сохранение collapsed state в `localStorage`;
- отдельную collapsible группу `Бесплатные модели`;
- hidden search input, чтобы picker не поднимал мобильную клавиатуру;
- отдельный entry `Qwen 3.8 Max · Оркестрированная` в Alibaba group.

Favorites используют существующий ключ `opencode:web:favorites`, поэтому обновление UI не должно сбрасывать старое избранное. Состояние свёрнутых provider groups хранится отдельно в `opencode:web:model-provider-collapse-v1`.

## Automatic queue

Delivery mode не относится к model routing и не выбирается вручную.

```text
idle                         → send
running + empty composer     → cancel current run
running + payload            → queue
```

Скрытый compatibility `Steer/Queue` слой остаётся только для OpenCode API adapter.

## RAG routing

Automatic RAG доступен только при выборе orchestrated model profile.

Оркестрированная модель и `fast-reader` используют `kb` только если локальный corpus способен materially улучшить ответ, например:

- datasheet;
- application note;
- reference design;
- PCB/layout rule;
- DipTrace documentation;
- indexed engineering video/transcript.

Для обычного coding lookup, общих знаний и задач, где corpus не нужен, RAG не должен добавлять latency.

При RAG timeout/error caller не должен зацикливаться. Нормальная политика: одна диагностика/повтор максимум, затем продолжить без RAG.

Обычные model profiles явно запрещают automatic `kb_knowledge_*` tools.

## Alibaba model catalog

В текущем provider config зарегистрированы:

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

`qwen3.8-max-preview` — compatibility ID старых sessions, который map-ится на `qwen3.8-max`.

`Qwen 3.8 Max · Оркестрированная` не является вторым API model ID. Это UI/profile entry поверх `qwen3.8-max` + orchestrated primary agent.

## Бесплатные модели

UI выделяет отдельную группу `Бесплатные модели`.

Определение идёт:

1. по V2 cost metadata — input/output/cache costs равны нулю;
2. при отсутствии metadata — ограниченный fallback по известным free IDs.

Бесплатная модель работает напрямую и сама по себе не становится частью automatic router path.

## Локальные модели

Provider `ollama` остаётся доступен для явного ручного выбора.

Default:

```text
OPENCODE_LOCAL_AUTO_START=0
OPENCODE_LOCAL_PROVIDER=ollama
```

То есть:

- OpenCode не должен автоматически стартовать локальный inference для обычной работы;
- отсутствие Ollama не ломает orchestrated cloud path;
- локальный provider выбирается как обычная модель;
- local Ollama не получает automatic RAG/subagent delegation.

## Permissions fast-reader

Политика deny-first:

```text
* → deny
read/glob/grep/list/lsp → allow
kb_knowledge_search/get/sources/status → allow
edit/shell/ingest/external dirs → deny, кроме явно разрешённых исключений
```

`.env` и `.env.*` запрещены для read-only worker; `.env.example` разрешён как публичная схема конфигурации.

## Проверка без платного inference

Doctor бесплатно проверяет config-level invariants:

- default underlying model — Max;
- `fast-reader` — Flash;
- automatic Ollama отсутствует;
- model IDs присутствуют в catalog;
- RAG/MCP status при наличии RAG.

Web smoke дополнительно проверяет state machine composer, mapping `Build/Plan × ordinary/orchestrated`, model sorting/favorites и наличие collapsible provider UI.

Для реального orchestration E2E остаётся ручной `Router E2E` smoke в Doctor. Он делает настоящий model inference и поэтому помечен как платный.
