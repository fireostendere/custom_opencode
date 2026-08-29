# Модели и routing

## Текущая автоматическая схема

Default primary model:

```text
bailian-cli/qwen3.8-max
```

Cheap bounded worker:

```text
fast-reader → bailian-cli/qwen3.6-flash
```

Title worker:

```text
title → bailian-cli/qwen3.6-flash
```

`local-reader` сохранён как hidden compatibility alias для старых sessions, но также использует `qwen3.6-flash`.

Ни один автоматический agent не использует `ollama/*`.

## Зачем нужен fast-reader

`fast-reader` используется для дешёвых read-only задач:

- найти файл/символ;
- прочитать небольшой набор файлов;
- разобрать лог;
- сделать точный repository lookup;
- получить ограниченное RAG evidence;
- вернуть короткое factual summary primary agent.

Он специально не получает edit/shell права.

Это снижает расход дорогой primary model на механический поиск, но не отдаёт дешёвому worker архитектурные или security-sensitive решения.

## Primary model

`qwen3.8-max` остаётся владельцем:

- пользовательской задачи;
- planning/reasoning;
- edit/shell операций;
- архитектурных решений;
- security-sensitive решений;
- синтеза нескольких источников;
- финальной проверки/ответа.

Delegation — опциональная оптимизация, а не обязательный этап каждого prompt.

## Build и Plan

В текущем config есть два primary agents:

### Build

Обычный рабочий режим. Может выполнять изменения в рамках разрешений OpenCode и вызывать только разрешённый subagent `fast-reader`.

### Plan

Read/plan-oriented primary mode. В config запрещены `edit` и `shell`, но разрешён `fast-reader`.

Важно: отдельный реализованный UI-режим `Router/Direct` в текущем config отсутствует. Router-like behavior реализуется через primary `build/plan` + разрешённый `fast-reader`. Не следует документировать или ожидать отдельный `Direct` switch, пока он не будет реально добавлен в код.

## RAG routing

RAG не вызывается автоматически для любого prompt.

Orchestrator и `fast-reader` должны использовать `kb` только если локальный корпус способен materially улучшить ответ, например:

- datasheet;
- application note;
- reference design;
- PCB/layout rule;
- DipTrace documentation;
- indexed engineering video/transcript.

Для обычного coding lookup, общих знаний и задач, где corpus не нужен, RAG не должен добавлять latency.

При RAG timeout/error caller не должен зацикливаться. Нормальная политика: одна диагностика/повтор максимум, затем продолжить без RAG.

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

Catalog может меняться вместе с Alibaba/OpenCode. `scripts/verify.sh` намеренно проверяет текущую allowlist, чтобы неожиданный drift был виден.

## Бесплатные модели

UI выделяет отдельную группу `Бесплатные модели`.

Определение идёт:

1. по V2 cost metadata — input/output/cache costs равны нулю;
2. при отсутствии metadata — ограниченный fallback по известным free IDs.

Бесплатная модель в picker не становится частью автоматического router path сама по себе.

## Локальные модели

Provider `ollama` остаётся доступен для явного ручного выбора.

Default:

```text
OPENCODE_LOCAL_AUTO_START=0
OPENCODE_LOCAL_PROVIDER=ollama
```

То есть:

- OpenCode не должен автоматически стартовать локальный inference для обычной работы;
- отсутствие Ollama не ломает primary routing;
- запуск игры/нагрузка GPU не влияет на автоматический cloud path;
- локальный provider можно выбрать вручную для эксперимента.

## Permissions fast-reader

Политика deny-first:

```text
* → deny
read/glob/grep/list/lsp → allow
kb_knowledge_search/get/sources/status → allow
edit/shell/ingest/external dirs → deny, кроме явно разрешённых исключений
```

`.env` и `.env.*` запрещены для read-only worker; `.env.example` разрешён как публичная схема конфигурации.

## Как проверить routing без платного inference

Doctor бесплатно проверяет config-level invariants:

- primary model — Max;
- `fast-reader` — Flash;
- automatic Ollama отсутствует;
- model IDs присутствуют в catalog.

Это доказывает конфигурацию, но не execution.

Для реального E2E есть ручной `Router E2E` smoke в Doctor. Он делает настоящий model inference и поэтому помечен как платный.
