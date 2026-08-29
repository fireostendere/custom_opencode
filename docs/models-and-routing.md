# Модели и routing

## Пользовательская модель

В UI остаются только два режима:

```text
Build
Plan
```

Orchestration больше не выглядит как третий mode рядом с ними. Она выбирается в model picker как отдельный model profile:

```text
Qwen 3.8 Max · Orchestrated
```

Обычные модели из picker работают напрямую.

## Direct profile

При выборе любой обычной модели UI автоматически использует внутренний `build-direct` или `plan-direct` agent в зависимости от выбранного `Build/Plan`.

Direct profile:

- использует выбранную модель напрямую;
- не имеет orchestrator system prompt;
- не может автоматически запускать `fast-reader`;
- не получает automatic RAG tools;
- в `Plan` дополнительно запрещены `edit` и `shell`.

Например:

```text
Build + GPT-5.6 Sol      → GPT-5.6 Sol direct
Build + Qwen3.8 Max      → Qwen3.8 Max direct
Plan  + Qwen3.8 Flash    → Qwen3.8 Flash direct, read/plan only
```

Внутренние direct agent IDs намеренно не показываются как дополнительные mode buttons.

## Orchestrated profile

При выборе:

```text
Qwen 3.8 Max · Orchestrated
```

используется тот же underlying model:

```text
bailian-cli/qwen3.8-max
```

но active primary agent становится `build` или `plan` с orchestrator policy.

Схема:

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

## Build и Plan

### Build

Обычный рабочий mode. В direct profile работает выбранная модель. В orchestrated profile Qwen Max может делегировать bounded read-only работу `fast-reader`.

### Plan

Read/plan-oriented mode. `edit` и `shell` запрещены и в direct, и в orchestrated profile. Orchestrated Plan при этом может использовать `fast-reader` для bounded retrieval.

Переключение `Build ↔ Plan` сохраняет текущий profile: direct остаётся direct, orchestrated остаётся orchestrated.

## Model picker

Model picker является главным местом выбора execution profile.

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
- отдельный entry `Qwen 3.8 Max · Orchestrated` в Alibaba group.

Favorites используют существующий ключ `opencode:web:favorites`, поэтому обновление UI не должно сбрасывать старое избранное. Состояние свёрнутых provider groups хранится отдельно в `opencode:web:model-provider-collapse-v1`.

## Automatic queue

Delivery mode не относится к model routing и больше не выбирается вручную.

```text
idle                         → send
running + empty composer     → stop
running + payload            → queue
```

Скрытый compatibility `Steer/Queue` слой остаётся только для OpenCode API adapter.

## RAG routing

Automatic RAG доступен только orchestrated profile.

Orchestrator и `fast-reader` используют `kb` только если локальный corpus способен materially улучшить ответ, например:

- datasheet;
- application note;
- reference design;
- PCB/layout rule;
- DipTrace documentation;
- indexed engineering video/transcript.

Для обычного coding lookup, общих знаний и задач, где corpus не нужен, RAG не должен добавлять latency.

При RAG timeout/error caller не должен зацикливаться. Нормальная политика: одна диагностика/повтор максимум, затем продолжить без RAG.

Direct profile explicitly denies automatic `kb_knowledge_*` tools.

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

`Qwen 3.8 Max · Orchestrated` не является вторым API model ID. Это UI/profile entry поверх `qwen3.8-max` + orchestrated primary agent.

## Бесплатные модели

UI выделяет отдельную группу `Бесплатные модели`.

Определение идёт:

1. по V2 cost metadata — input/output/cache costs равны нулю;
2. при отсутствии metadata — ограниченный fallback по известным free IDs.

Бесплатная модель работает direct и не становится частью automatic router path сама по себе.

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
- локальный provider выбирается как direct model;
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

Web smoke дополнительно проверяет state machine composer, mapping `Build/Plan × direct/orchestrated`, model sorting/favorites и наличие collapsible provider UI.

Для реального orchestration E2E остаётся ручной `Router E2E` smoke в Doctor. Он делает настоящий model inference и поэтому помечен как платный.
