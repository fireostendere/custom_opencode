# custom_opencode

Переносимый комплект поверх OpenCode V2: собственный ChatGPT-подобный web/PWA client, Alibaba/Qwen routing, безопасная работа с локальными проектами, диагностика/self-test и опциональный инженерный RAG через MCP.

## Что предоставляет

- web/PWA UI для OpenCode sessions;
- isolated quick-session workspaces;
- `Проекты → Папки на ПК` с filesystem allowlist и symlink containment;
- только два пользовательских режима работы: `Build` и `Plan`;
- model picker с избранным, сортировкой, сворачиваемыми провайдерами и отдельной группой бесплатных моделей;
- `Qwen 3.8 Max · Оркестрированная` прямо в model picker;
- серверную persistent queue, которая переживает reload/закрытие PWA и поддерживает reorder/delete;
- одну контекстную кнопку composer: send / cancel / queue;
- native OpenCode questions: single/multi-select, описания вариантов и собственный текстовый ответ;
- компактные permission cards и project-level allow/deny policies;
- Project settings: persistent system instructions, default Build/Plan/cloud model profile и RAG policy;
- Changes/Review: file stats, diff по файлам/hunks, safe revert файла или отдельного hunk;
- раскрываемое дерево оркестрации с child sessions и RAG marker;
- компактный status bar: model/context/cost/runtime/RAG/queue;
- native slash commands;
- Markdown/code/tool/reasoning renderers;
- files и clipboard images;
- Git/VCS UI, fork/duplicate/handoff, notifications, drafts;
- Qwen Token Plan и Codex rate-limit sidebar;
- actionable PWA notifications и deep links к session;
- orchestration `Qwen 3.8 Max → Qwen 3.6 Flash fast-reader`;
- optional `mcp-rag` integration через `kb` MCP;
- `/rag-start` и `/doctor`;
- pre-install verifier и post-install zero-LLM-token self-test;
- user systemd deployment и one-command update.

Локальные Ollama models остаются ровно в прежнем manual-only режиме. Новые workflow-фичи не выбирают, не запускают, не выгружают и не переключают local provider автоматически.

## Build / Plan и model profiles

`Build` и `Plan` — единственные пользовательские режимы выполнения:

- `Build` — обычный рабочий режим выбранной модели с доступными ей edit/shell permissions;
- `Plan` — read/plan-only режим без edit и shell.

Оркестрация выбирается в model picker, а не дополнительным режимом:

```text
Build | Plan
     +
обычная модель                    → direct
Qwen 3.8 Max · Оркестрированная   → Max → bounded fast-reader → optional RAG
```

Внутренние OpenCode agent IDs `build`, `plan`, `build-direct`, `plan-direct` являются implementation detail и не должны отображаться как дополнительные пользовательские режимы.

## Composer и persistent queue

Отдельного `Steer / Queue` переключателя в UI нет.

```text
работы нет                         → ↑ Отправить
работа идёт + composer пустой      → × Отменить текущую работу
работа идёт + есть текст/вложение  → ↑ Отправить в очередь
```

Очередь хранится сервером в feature-state, а не только в памяти открытой вкладки. Поэтому queued prompts продолжают выполняться после reload/закрытия PWA. В status bar можно открыть очередь, удалить сообщение или поменять порядок.

Queue dispatch использует уже выбранную модель текущей session и сам по себе model/provider не меняет.

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

Project settings намеренно не содержат local-model automation. Локальную модель можно выбрать только вручную в обычном model picker.

На permission card есть `Разрешать в проекте`, который сохраняет точечное allow rule вместо глобального бесконтрольного `Always`.

## Changes / Review

Git drawer остаётся основной точкой просмотра изменений, но поверх него добавлен review layer:

- количество файлов и `+/-` статистика;
- раскрываемые file diffs;
- hunks;
- `Отменить файл` через bounded `git restore`;
- `Отменить hunk` через reverse patch;
- containment: web backend не принимает revert path вне разрешённого project root.

## RAG

RAG полностью опционален. Если `mcp-rag` не найден или явно отключён через `MCP_RAG_ENABLED=0`, installer создаёт рабочий OpenCode config с `kb.disabled=true`.

Когда RAG установлен, `/rag-start` может без LLM-токенов проверить/поднять локальный Qdrant, проверить corpus/index, подключить `kb` к текущему workspace и проверить MCP tools.

Поиск по уже проиндексированному corpus выполняется локально: Qdrant + FastEmbed + BM25 + optional reranker.

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
- [Модели и routing](docs/models-and-routing.md)
- [RAG integration](docs/rag.md)
- [`/rag-start`](docs/rag-start.md)
- [Doctor](docs/doctor.md)
- [Эксплуатация и recovery](docs/operations.md)
- [Troubleshooting](docs/troubleshooting.md)

Отдельная документация по созданию/индексации corpus находится в репозитории `mcp-rag`.

## Структура

```text
app/       web client + authenticated proxy + Doctor/RAG/workflow lifecycle
config/    OpenCode V2 providers, agents, prompts, plugins
scripts/   verify/install/update/RAG/workflow probes
systemd/   user service
docs/      пользовательская и эксплуатационная документация
```

Production server stack заканчивается `app/server_workflow.py`, который композиционно добавляет persistent workflow endpoints поверх существующих RAG/Doctor/base proxy layers.

## Security defaults

- secrets и host-specific URLs — только в `.env`;
- web UI использует Basic Auth;
- рекомендуемый bind — loopback;
- project browser ограничен `OPENCODE_PROJECT_ROOTS`;
- quick workspace cleanup защищён containment checks;
- local models остаются manual-only и не входят в workflow automation;
- обычные модели не получают automatic RAG/subagent delegation;
- RAG ingest не разрешён read-only worker;
- persistent workflow state создаётся с user-only permissions;
- git revert ограничен project root и конкретным path/patch;
- MCP execution timeout ограничен;
- install/update завершается ошибкой, если critical host self-test не прошёл.

OpenCode V2 остаётся изменяющимся upstream, поэтому verifier и host-level Doctor являются частью штатной эксплуатации, а не только development tooling.
