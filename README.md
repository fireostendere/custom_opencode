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
- durable checkpoints, event history и per-stage token/cost accounting, включая `wasted_retries`;
- Task Center для server tasks, profiles, checkpoints, artifacts и resource state;
- одну контекстную кнопку composer: send / cancel / queue;
- native OpenCode questions: single/multi-select, описания вариантов и собственный текстовый ответ;
- compact server-generated permission previews и project-level allow/deny policies;
- Project settings: persistent system instructions, default Build/Plan/cloud model profile и RAG policy;
- Changes/Review: file stats, diff по файлам/hunks, safe revert файла или отдельного hunk;
- раскрываемое дерево оркестрации с child sessions и RAG marker;
- AST/symbol repository index, embeddings, dependency graph, bounded Git graph и semantic symbol diff;
- bounded dynamic context с native OpenCode compaction, automatic dedup и server-managed retrieval;
- pre-execution read/tool-result cache с Git-aware invalidation;
- large-output artifact storage с range/search;
- structured agent mailbox, typed handoff и speculative parallel research;
- verification pipeline, failure classifier, automatic review gate, loop/stuck/conflict detection;
- isolated Git worktree tasks, patch ownership и fail-closed merge/cleanup;
- resource-aware adaptive profile: local coding model при свободном хосте, cloud fallback при game/CPU/GPU/VRAM pressure или unavailable local;
- OpenCode-central MCP Code Mode/lazy loading, server policy/rate-limit/health layer и shared RAG cache;
- scoped Secret Broker без plaintext secrets в UI/model context;
- enforced sandbox profiles `safe`, `repo-write`, `docker`, `wsl`, `full-machine`;
- session branching с переносом durable agent state/handoff;
- zero-token replay сохранённых responses/tool results;
- remote authenticated status/action API и optional webhook notifications;
- local telemetry dashboard: task usage, model success/latency, MCP health, GPU/VRAM и routing state;
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
- pre-install verifier, Runtime V2/V3 smokes и post-install zero-LLM-token self-test;
- user systemd deployment и one-command update.

Обычный `direct` профиль никогда автоматически не меняет вручную выбранную модель. Автоматический local/cloud routing включается только при выборе server profile с `route=auto`, например `qwen3.8-coder`.

[`docs/server-runtime-v2.md`](docs/server-runtime-v2.md) описывает базовый durable runtime layer. Полный актуальный control plane, включая AST/embeddings, native compaction, MCP Code Mode, sandbox enforcement, scoped secrets, shared RAG, replay, adaptive telemetry routing и remote API, описан в [`docs/server-runtime-v3.md`](docs/server-runtime-v3.md).

## Build / Plan и model profiles

`Build` и `Plan` — единственные пользовательские режимы выполнения:

- `Build` — обычный рабочий режим выбранной модели с доступными ей edit/shell permissions;
- `Plan` — read/plan-only режим без edit и shell.

Оркестрация и routing выбираются в model picker, а не дополнительным режимом:

```text
Build | Plan
     +
direct                         → сохранить выбранную OpenCode model
qwen3.8-coder                  → local/cloud adaptive coding
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

## Project settings, permissions и sandbox

Кнопка `Project` в header открывает настройки текущей директории:

- persistent instructions — передаются как отдельный OpenCode system context и не вставляются в видимый user text;
- default `Build / Plan`;
- default orchestrated или конкретная cloud model;
- `RAG: auto/on/off`;
- ordered permission rules `action + resource glob → ask/allow/deny`.

На permission card есть server-generated краткое описание действия и `Разрешать в проекте`, который сохраняет точечное allow rule вместо глобального бесконтрольного `Always`. R3/R4 остаются interactive независимо от project allow.

Runtime V3 добавляет отдельный enforcement layer до tool execution: path containment, patch ownership, loop/rate policies и sandbox profile. `safe`/`repo-write` используют bubblewrap, когда он доступен; `docker`/`wsl` запускают shell/build в соответствующем runner; `full-machine` требует явного `OPENCODE_ALLOW_FULL_MACHINE=1`.

## Server Runtime V2/V3

Runtime V2 добавляет durable task/store layer, а Runtime V3 — полный server control plane поверх существующего OpenCode backend:

```text
Browser / PWA / OpenCode clients
    |
    v
server_workflow.py
    |
    +--> server_runtime.py            durable task lifecycle / queue / verification
    +--> runtime_v3.py                context/index/sandbox/RAG/replay/adaptive routing
    +--> runtime_v3_ext.py            worktree merge / MCP telemetry / runtime APIs
    +--> runtime_completion.py        previews/cache/retry accounting/remote actions
    +--> runtime_store.py             SQLite/WAL state
    +--> server permission control plane
    +--> OpenCode V2 backend + central MCP host
```

После значимых runtime-этапов сохраняются checkpoints. In-flight task после рестарта переходит в recovery: если upstream OpenCode session ещё busy, task снова привязывается к ней; если нет — task ставится на паузу вместо молчаливого повторного model call.

Writable standalone task можно создать в отдельном Git worktree. Сервер умеет fail-closed объединить tracked/untracked изменения обратно в ownership root и не перезаписывает dirty/conflicting target path.

Для сложного исследования Task Center умеет создать 2–3 дешёвых read-only research forks и зависимый aggregator. Findings передаются через structured mailbox. Session branch merge также переносит meaningful checkpoints, typed handoff и route/state metadata.

Подробнее: [Server Runtime V2](docs/server-runtime-v2.md) и [Server Runtime V3](docs/server-runtime-v3.md).

## Dynamic context, cache и repository index

OpenCode V2 native compaction остаётся authoritative conversation-history mechanism. Runtime V3 выставляет install-time compaction budget, дополнительно следит за profile/model context budget и запрашивает native compaction при переполнении.

Server context собирается отдельно и ограниченно: project instructions/memory, decisions, mailbox/handoff, semantic repository matches, changed symbols и selective shared RAG. Повторяющиеся секции дедуплицируются.

Repository daemon поддерживает Python AST symbols, JS/TS symbol/import extraction, dependency edges, bounded Git graph и embeddings. При наличии `sentence-transformers` используется локальная модель; иначе deterministic hashed lexical fallback не требует внешнего API.

Cacheable read tools оборачиваются через OpenCode V2 tool transform. Cache hit предотвращает сам underlying read call. Cache key включает tool input, Git HEAD и working-tree status, поэтому изменение репозитория инвалидирует stale read cache.

## Verification / Review

Git drawer остаётся основной точкой просмотра изменений:

- количество файлов и `+/-` статистика;
- раскрываемые file diffs;
- hunks;
- `Отменить файл` через bounded `git restore`;
- `Отменить hunk` через reverse patch;
- containment: web backend не принимает revert path вне разрешённого project root.

После writable runtime task сервер автоматически запускает обнаруженные lint/typecheck/test checks. Network/environment/flaky failures отделяются от code failures. Code failures могут породить bounded repair task, а нетривиальный diff — read-only review task. Retry/repair/recovery usage учитывается как `wasted_retries` отдельно от implementation.

## RAG и MCP

RAG полностью опционален. Если `mcp-rag` не найден или явно отключён через `MCP_RAG_ENABLED=0`, installer создаёт рабочий OpenCode config с `kb.disabled=true`.

Когда RAG установлен, `/rag-start` может без LLM-токенов проверить/поднять локальный Qdrant, проверить corpus/index, подключить `kb` к текущему workspace и проверить MCP tools.

OpenCode V2 остаётся единственным центральным MCP host. Installer включает MCP Code Mode для `kb`, чтобы полные tool schemas не занимали provider context заранее. Runtime V3 поверх этого даёт server policy, rate limit, health/tool metadata, secret handling и shared read/RAG cache, поэтому MCP не подключается отдельно к каждому web client.

## Replay, telemetry и remote API

Managed run может быть сохранён как replay artifact с исходными assistant responses/tool results. Replay API возвращает recording + events/checkpoints/usage и не делает новых model calls (`modelCalls: 0`).

Telemetry хранится локально по task/model/stage и включает token/cost/latency/success; adaptive router использует накопленные model stats вместе с CPU/GPU/VRAM/game/local-health сигналами.

Authenticated remote API позволяет с телефона получить pending tasks/permissions и выполнить cancel/pause/resume либо permission `once/reject`. Для significant task states доступен optional webhook; non-loopback destination требует explicit opt-in.

## Быстрый старт

Требуются OpenCode V2, Python 3, Node.js и `systemd --user`.

```bash
cp .env.example .env
# заполнить .env
./scripts/verify.sh
./scripts/verify-runtime-v3.sh
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
- [Server Runtime V3](docs/server-runtime-v3.md)
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

Production server stack заканчивается `app/server_workflow.py`, который композиционно устанавливает Runtime V2, Runtime V3, completion layer, permission control plane и RAG lifecycle поверх base proxy layers. OpenCode V2 остаётся model/tool/MCP execution engine.

## Security defaults

- secrets и host-specific URLs — только в `.env`;
- web UI использует Basic Auth;
- рекомендуемый bind — loopback;
- project browser ограничен `OPENCODE_PROJECT_ROOTS`;
- quick workspace cleanup защищён containment checks;
- `direct` profile не меняет вручную выбранную модель;
- auto local/cloud routing ограничен явно выбранными server profiles;
- RAG ingest не разрешён read-only worker;
- persistent runtime state и artifacts создаются с user-only permissions;
- file mutation ограничена managed project/worktree;
- managed worktree merge/cleanup fail-closed при dirty/conflicting state;
- git revert ограничен project root и конкретным path/patch;
- MCP execution и gateway rate limits ограничены;
- Secret Broker snapshot никогда не сериализует plaintext secret values;
- full-machine sandbox disabled by default;
- remote webhook delivery disabled for non-loopback destinations by default;
- install/update завершается ошибкой, если critical host self-test не прошёл.

OpenCode V2 остаётся изменяющимся upstream, поэтому verifier, runtime smokes и host-level Doctor являются частью штатной эксплуатации, а не только development tooling.
