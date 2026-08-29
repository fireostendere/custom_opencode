# Модели и routing

## Пользовательская модель выполнения

Web UI фиксирован в `Build`. Visible переключатель `Build / Plan` удалён: execution mode больше не является пользовательским выбором.

Модель/профиль выбирается в model picker. Есть два уровня:

1. обычная конкретная модель — direct/manual selection;
2. server profile Runtime V2/V3 — profile с заданным routing/policy.

`plan`, `plan-direct` и соответствующая matrix остаются внутри OpenCode/runtime как compatibility/read-only implementation detail, но frontend возвращает старые пользовательские sessions в Build-equivalent profile.

## Direct/manual model

Обычная выбранная модель работает напрямую через `build-direct`:

- выбранный provider/model сохраняется;
- resource scheduler не имеет права подменить эту модель;
- orchestrator prompt отсутствует;
- automatic fast-reader/subagent delegation запрещена;
- automatic RAG tools для direct primary запрещены.

Примеры:

```text
Qwen3.8 Max       → build-direct → Qwen3.8 Max
Qwen3.8 Flash     → build-direct → Qwen3.8 Flash
Ollama/qwen...    → build-direct → локальная модель после ручного выбора
```

Это важный invariant: наличие adaptive scheduler не превращает любую вручную выбранную модель в Auto.

## Server model profiles

`app/model_registry.py` предоставляет профили:

| Profile | Route | Основная модель/policy | Назначение |
|---|---|---|---|
| `direct` | `selected` | текущая selected model | ручной direct path |
| `qwen3.8-coder` | `auto` | local coder или cloud Max | основной adaptive coding profile |
| `qwen3.8-orchestrated` | `cloud` | cloud Max + Flash worker | orchestration + optional RAG |
| `qwen3.8-review` | `cloud` | review model, safe sandbox | review/read path |
| `qwen3.8-fast` | `cloud` | Flash | быстрый bounded read path |

Default refs настраиваются через:

```text
OPENCODE_LOCAL_CODER_MODEL=ollama/qwen3.8:27b
OPENCODE_CLOUD_CODER_MODEL=bailian-cli/qwen3.8-max
OPENCODE_FAST_MODEL=bailian-cli/qwen3.6-flash
OPENCODE_REVIEW_MODEL=bailian-cli/qwen3.8-max
```

`runtime-dashboard.js` инжектит server profiles в model picker и добавляет profile badge/Task Center.

## Adaptive local/cloud routing

Автоматический routing работает только если выбран профиль с `route=auto`, сейчас это `qwen3.8-coder`.

`ResourceScheduler` учитывает:

- `OPENCODE_RESOURCE_SCHEDULER`;
- configured game process fragments;
- CPU/load pressure;
- доступность local Ollama endpoint;
- hysteresis/resource policy Runtime V3.

Логика высокого уровня:

```text
manual direct / route=selected → оставить selected model
route=cloud                    → cloud pinned
route=auto + игра              → cloud
route=auto + high pressure     → cloud
route=auto + idle + local up   → local
route=auto + local unavailable → cloud fallback
```

Game/process detection не является глобальным скрытым router-ом. Он влияет только на auto server profiles.

## Оркестрированная модель

`qwen3.8-orchestrated` / UI entry `Qwen 3.8 Max · Оркестрированная` использует cloud Max и разрешает bounded delegation:

```text
Qwen 3.8 Max
      ↓ bounded read/delegation при необходимости
fast-reader → Qwen 3.6 Flash
      ↓ corpus-relevant engineering lookup
kb MCP → mcp-rag
```

`fast-reader` read-only: repository exploration, logs, точечный lookup и bounded RAG evidence. Финальное reasoning/edit/security решение остаётся у primary Max/runtime policy.

Automatic RAG разрешён orchestration/server retrieval path; ordinary direct primary не получает automatic delegation.

## Review и fast profiles

`qwen3.8-review` cloud-pinned и использует safe/read-oriented execution policy. Он предназначен для verification/review stages Runtime V2/V3, а не для скрытого изменения обычной active model.

`qwen3.8-fast` cloud-pinned на Flash и предназначен для дешёвых/быстрых bounded read stages.

Runtime V3 capability registry хранит coding/review/planning/fast-path hints, context class, tool/vision support и cost class, чтобы scheduler выбирал profile/model только в пределах разрешённой profile policy.

## Model picker

Picker поддерживает:

- favorites-first sorting;
- collapsible provider groups;
- отдельную `Бесплатные модели` group;
- hidden search input на mobile;
- ordinary models;
- `Qwen 3.8 Max · Оркестрированная` compatibility profile;
- Runtime server profiles;
- per-session profile state.

Profile badge рядом с model control показывает `direct`/server profile и открывает тот же model picker.

## Queue и task model state

Есть два совместимых слоя.

Legacy persistent queue:

- хранит prompt до освобождения session;
- отправляет его через текущую model/session;
- сам provider/model не меняет.

Runtime V2/V3 task queue:

- task хранит `profile`;
- server profile может вычислить route при dispatch/recovery;
- direct profile сохраняет selected model;
- auto profile может выбрать local/cloud согласно resource policy;
- priority/dependencies/pause/resume/checkpoints переживают reload/restart.

Следовательно, фраза «queue никогда не выбирает model» верна только для legacy direct facade. Runtime task с explicit auto profile сознательно проходит server routing.

## Project settings

Project settings могут задавать:

- persistent system instructions;
- ordinary cloud/orchestrated default для compatibility workflow surface;
- RAG preference;
- permission rules.

Visible execution mode всё равно Build. Старый `mode` field — compatibility data.

Обычный project default не должен самопроизвольно превращать direct user selection в Ollama/Auto. Server Runtime profiles выбираются как отдельные profiles и имеют собственную routing policy.

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

`qwen3.8-max-preview` остаётся compatibility ID старых sessions.

UI/profile label не обязан быть реальным API model ID: server profile указывает реальные `cloudModel/localModel/workerModel` refs отдельно.

## Бесплатные модели

`Бесплатные модели` определяется сначала по V2 cost metadata, затем ограниченным fallback по known IDs. Free ordinary model остаётся direct model, пока пользователь явно не выберет server profile.

## Permissions fast-reader

Deny-first policy:

```text
* → deny
read/glob/grep/list/lsp → allow
kb_knowledge_search/get/sources/status → allow
edit/shell/ingest/external dirs → deny, кроме явно разрешённых исключений
```

`.env` и `.env.*` запрещены read-only worker; `.env.example` разрешён как публичная схема.

## Проверка

Zero-token verification должна фиксировать как минимум:

- Build-only user surface и internal plan compatibility;
- direct model preservation;
- server profiles/capability registry;
- scheduler decisions для game/high-pressure/local-down cases;
- persistent Runtime tasks/checkpoints;
- ordinary/orchestrated picker paths;
- RAG/MCP invariants;
- permission/sandbox boundaries.

Runtime V3 имеет отдельный `scripts/verify-runtime-v3.sh`; основной `scripts/verify.sh` включает web/runtime smokes. Paid model/router E2E остаётся ручной проверкой Doctor/runtime smoke, когда нужен реальный inference.
