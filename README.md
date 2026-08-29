# custom_opencode

Переносимый комплект поверх OpenCode V2: собственный ChatGPT-подобный web/PWA client, Alibaba/Qwen routing, серверный task/control runtime, безопасная работа с локальными проектами, диагностика/self-test и опциональный инженерный RAG через MCP.

## Что предоставляет

- web/PWA UI для OpenCode sessions;
- isolated quick-session workspaces;
- `Проекты → Папки на ПК` с filesystem allowlist и symlink containment;
- только два пользовательских режима работы: `Build` и `Plan`;
- model picker с избранным, сортировкой, сворачиваемыми провайдерами и отдельной группой бесплатных моделей;
- server model profiles: `qwen3.8-coder`, `qwen3.8-orchestrated`, `qwen3.8-review`, fast path;
- model capability registry: vision/tools/context/cost/quality hints остаются на сервере;
- SQLite/WAL task queue с priority, dependencies, cancel, pause/resume и recovery;
- durable checkpoints, event history и per-stage token/cost accounting;
- Task Center для server tasks, profiles, checkpoints, artifacts и resource state;
- одну контекстную кнопку composer: send / cancel / queue;
- native OpenCode questions: single/multi-select, описания вариантов и собственный текстовый ответ;
- компактные permission cards и project-level allow/deny policies;
- Project settings: persistent system instructions, default Build/Plan/cloud model profile и RAG policy;
- Changes/Review: file stats, diff по файлам/hunks, safe revert файла или отдельного hunk;
- раскрываемое дерево оркестрации с child sessions и RAG marker;
- repo/context services: bounded symbol/dependency index, semantic diff, project memory и decision log;
- large-output artifact storage с range/search;
- structured agent mailbox, typed handoff foundation и speculative parallel research;
- verification pipeline, failure classifier, automatic review gate, loop/stuck/conflict detection;
- isolated Git worktree tasks с fail-closed cleanup;
- resource-aware auto profile: local coding model при свободном хосте, cloud fallback при game/load/unavailable local;
- MCP health/catalog gateway facade и Secret Broker foundation;
- compact status bar: model/context/cost/runtime/RAG/queue;
- native slash commands;
- Markdown/code/tool/reasoning renderers;
- files и clipboard images;
- Git/VCS UI, fork/duplicate/handoff, notifications, drafts;
- Qwen Token Plan и Codex rate-limit sidebar;
- actionable PWA notifications и deep links к session;
- orchestration `Qwen 3.8 Max → Qwen 3.6 Flash fast-reader`;
- optional `mcp-rag` integration через `kb` MCP;
- `/rag-start` и `/doctor`;
- pre-install verifier, runtime-v2 smoke и post-install zero-LLM-token self-test;
- user systemd deployment и one-command update.

Обычный `direct` профиль никогда автоматически не меняет вручную выбранную модель. Автоматический local/cloud routing включается только при выборе server profile с `route=auto`, например `qwen3.8-coder`.

Подробные границы первой версии Runtime V2 — в [`docs/server-runtime-v2.md`](docs/server-runtime-v2.md). В частности, MCP gateway пока является health/catalog facade, repo index пока не полноценный AST/embedding daemon, sandbox profiles пока metadata/policy intent, а Secret Broker ещё не перехватывает все существующие credentials.

## Build / Plan и model profiles

`Build` и `Plan` — единственные пользовательские режимы выполнения:

- `Build` — обычный рабочий режим выбранной модели с доступными ей edit/shell permissions;
- `Plan` — read/plan-only режим без edit и shell.

Оркестрация и routing выбираются в model picker, а не дополнительным режимом:

```text
Build | Plan
     +
direct                         → сохранить выбранную OpenCode model
qwen3.8-coder                  → local/cloud auto coding
qwen3.8-orchestrated           → Qwen Max → bounded fast-reader → optional RAG
qwen3.8-review                 → read-only review
```

Внутренние OpenCode agent IDs `build`, `plan`, `build-direct`, `plan-direct` являются implementation detail и не должны отображаться как дополнительные пользовательские режимы.

## Composer и server task queue

Отдельного `Steer / Queue` переключателя в UI нет.

```text
работы нет                         → ↑ Отправить
работа идёт + composer пустой      → × Отменить текущую работу
работа идёт + есть текст/вложение  → ↑ Отправить в очередь
```

Legacy `/client-queue.json` сохранён как compatibility facade. Внутри новые queued prompts сохраняются как SQLite runtime tasks и поддерживают priority, dependencies, pause/resume/cancel, checkpoints и recovery после рестарта web process.

Task Center позволяет открыть server tasks текущей session, поменять priority/dependencies, поставить задачу на паузу, продолжить или отменить, посмотреть checkpoints, usage, event history и artifacts.

## Questions / выбор вариантов

Когда модель вызывает native OpenCode `question`, web client показывает отдельную карточку вместо неработающего текстового prompt:

- single-select;
- multi-select;
- label + description;
- `Свой вариант…` для каждого вопроса;
- несколько вопросов в одной карточке;
- reject/cancel;
- PWA notification с deep link в нужную session.

Ответ отправляется через native question reply API и продолжает остановленный agent loop.

## Project settings и permissions

Кнопка `Project` в header открывает настройки текущей директории:

- persistent instructions — передаются при отправке как отдельный OpenCode `system` context и не вставляются в видимый user text;
- default `Build / Plan`;
- default orchestrated или конкретная cloud model;
- `RAG: auto/on/off`;
- ordered permission rules `action + resource glob → ask/allow/deny`.

На permission card есть `Разрешать в проекте`, который сохраняет точечное allow rule вместо глобального бесконтрольного `Always`.

Permission control plane остаётся фактическим enforcement layer. Runtime sandbox profiles (`safe`, `repo-write`) пока описывают intended scope, но не заменяют permission policy системным/Docker sandbox.

## Server Runtime V2

Runtime V2 добавляет серверный control plane поверх существующего OpenCode backend:

```text
Browser / PWA
    |
    v
server_workflow.py
    |
    +--> server_runtime.py
    |      +--> runtime_store.py        SQLite/WAL tasks/events/checkpoints/usage
    |      +--> model_registry.py       capabilities/profiles/resource scheduler
    |      +--> repo_services.py        repo/context/artifact/verification services
    |
    +--> permission control plane
    +--> RAG lifecycle
    +--> OpenCode V2 backend
```

После значимых runtime-этапов сохраняются checkpoints. In-flight task после рестарта переходит в recovery: если upstream OpenCode session ещё busy, task снова привязывается к ней; если нет — task ставится на паузу вместо молчаливого повторного model call.

Writable standalone task можно создать в отдельном Git worktree. Dirty managed worktree автоматически не удаляется.

Для сложного исследования Task Center умеет создать 2–3 дешёвых read-only research forks и зависимый aggregator. Findings передаются через structured mailbox.

Подробнее: [Server Runtime V2](docs/server-runtime-v2.md).

## Changes / Review

Git drawer остаётся основной точкой просмотра изменений, но поверх него добавлен review layer:

- количество файлов и `+/-` статистика;
- раскрываемые file diffs;
- hunks;
- `Отменить файл` через bounded `git restore`;
- `Отменить hunk` через reverse patch;
- containment: web backend не принимает revert path вне разрешённого project root.

После writable runtime task сервер может автоматически запустить обнаруженные lint/typecheck/test checks. Network/environment/flaky failures отделяются от code failures. Code failures могут породить bounded repair task, а нетривиальный diff — read-only review task.

## RAG

RAG полностью опционален. Если `mcp-rag` не найден или явно отключён через `MCP_RAG_ENABLED=0`, installer создаёт рабочий OpenCode config с `kb.disabled=true`.

Когда RAG установлен, `/rag-start` может без LLM-токенов проверить/поднять локальный Qdrant, проверить corpus/index, подключить `kb` к текущему workspace и проверить MCP tools.

Поиск по уже проиндексированному corpus выполняется локально: Qdrant + FastEmbed + BM25 + optional reranker.

Runtime V2 пока не заменяет `kb` полным собственным MCP proxy: `/client-mcp-gateway.json` предоставляет server-side namespace/health/catalog facade, а tool execution остаётся в существующем OpenCode MCP path.

## Быстрый старт

Требуются OpenCode V2, Python 3, Node.js и `systemd --user`.

```bash
cp .env.example .env
# заполнить .env
./scripts/verify.sh
./scripts/install.sh
```

После установки:

```bash
custom-opencode
```

Обновление:

```bash
custom-opencode-update
```

Installer по умолчанию выполняет pre-install verification и post-install runtime self-test. Платный model inference автоматически не запускается.

## Документация

Полный индекс: [`docs/README.md`](docs/README.md).

Основные разделы:

- [Установка, миграция и обновление](docs/installation.md)
- [Конфигурация `.env`](docs/configuration.md)
- [Архитектура и возможности](docs/architecture.md)
- [Server Runtime V2](docs/server-runtime-v2.md)
- [Permission control plane](docs/control-plane.md)
- [Модели и routing](docs/models-and-routing.md)
- [RAG integration](docs/rag.md)
- [`/rag-start`](docs/rag-start.md)
- [Doctor](docs/doctor.md)
- [Эксплуатация и recovery](docs/operations.md)
- [Troubleshooting](docs/troubleshooting.md)

Отдельная документация по созданию/индексации corpus находится в репозитории `mcp-rag`.

## Структура

```text
app/       web client + authenticated proxy + runtime/control/RAG lifecycle
config/    OpenCode V2 providers, agents, prompts, plugins
scripts/   verify/install/update/RAG/runtime probes
systemd/   user service
docs/      пользовательская и эксплуатационная документация
```

Production server stack заканчивается `app/server_workflow.py`, который композиционно добавляет Runtime V2, persistent workflow endpoints, permission control plane и RAG lifecycle поверх base proxy layers.

## Security defaults

- secrets и host-specific URLs — только в `.env`;
- web UI использует Basic Auth;
- рекомендуемый bind — loopback;
- project browser ограничен `OPENCODE_PROJECT_ROOTS`;
- quick workspace cleanup защищён containment checks;
- `direct` profile не меняет вручную выбранную модель;
- auto local/cloud routing ограничен явно выбранными server profiles;
- обычные модели не получают automatic RAG/subagent delegation;
- RAG ingest не разрешён read-only worker;
- persistent runtime state и artifacts создаются с user-only permissions;
- managed worktree cleanup fail-closed при dirty state;
- git revert ограничен project root и конкретным path/patch;
- MCP execution timeout ограничен;
- Secret Broker snapshot никогда не сериализует plaintext secret values;
- install/update завершается ошибкой, если critical host self-test не прошёл.

OpenCode V2 остаётся изменяющимся upstream, поэтому verifier, runtime smoke и host-level Doctor являются частью штатной эксплуатации, а не только development tooling.
