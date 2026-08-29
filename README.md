# custom_opencode

Переносимый комплект поверх OpenCode V2: собственный ChatGPT-подобный web/PWA client, Alibaba/Qwen routing, безопасная работа с локальными проектами, диагностика/self-test и опциональный инженерный RAG через MCP.

## Что предоставляет

- web/PWA UI для OpenCode sessions;
- собственную login page вместо browser-native Basic Auth prompt;
- подписанные `HttpOnly` web sessions, `Запомнить вход`, logout и возврат в исходный dialog после re-auth;
- isolated quick-session workspaces;
- `Проекты → Папки на ПК` с filesystem allowlist и symlink containment;
- Build-only пользовательский execution surface;
- model picker с избранным, сортировкой, сворачиваемыми провайдерами и отдельной группой бесплатных моделей;
- `Qwen 3.8 Max · Оркестрированная` прямо в model picker;
- серверную persistent queue, которая переживает reload/закрытие PWA и поддерживает reorder/delete;
- одну контекстную кнопку composer: send / cancel / queue;
- native OpenCode questions: single/multi-select, описания вариантов и собственный текстовый ответ;
- session-scoped compact permission cards и project-level allow/deny policies;
- Project settings: persistent system instructions, cloud model profile, RAG policy и permission rules;
- Changes/Review: file stats, diff по файлам/hunks, safe revert файла или отдельного hunk;
- раскрываемое дерево оркестрации с child sessions и RAG marker;
- компактный status bar: model/context/cost/runtime/RAG/queue;
- light/dark/system theme, preset/custom accent color и сохранение оформления;
- reduced-motion-aware микроанимации;
- mobile drawer со swipe справа налево, Back и tap/click вне панели;
- сворачиваемую панель provider limits с запоминанием состояния;
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

Локальные Ollama models остаются manual-only. Workflow layer не выбирает, не запускает, не выгружает и не переключает local provider автоматически.

## Build-only и model profiles

Пользователь больше не выбирает `Build / Plan`: интерфейс всегда работает в Build. Старые `plan`/`plan-direct` остаются только внутренней совместимостью и автоматически переводятся обратно в Build profile.

Оркестрация выбирается model profile, а не execution mode:

```text
обычная модель                    → build-direct
Qwen 3.8 Max · Оркестрированная   → build → bounded fast-reader → optional RAG
```

Внутренние OpenCode agent IDs не должны отображаться как отдельные пользовательские режимы.

## Composer и persistent queue

Отдельного `Steer / Queue` переключателя в UI нет.

```text
работы нет                         → ↑ Отправить
работа идёт + composer пустой      → × Отменить текущую работу
работа идёт + есть текст/вложение  → ↑ Отправить в очередь
```

Очередь хранится сервером в feature-state, а не только в памяти открытой вкладки. Поэтому queued prompts продолжают выполняться после reload/закрытия PWA.

## Авторизация

Обычный web UX использует `/login.html` + `/auth/login`.

После успешного входа сервер выдаёт signed `HttpOnly; SameSite=Strict` cookie. При `Запомнить вход` по умолчанию используется 30-дневный TTL. Пароль приложением в browser storage не сохраняется.

Если web session истекла во время работы, клиент сохраняет полный текущий route, включая `#/session/...`, и после повторного входа возвращает пользователя туда же.

Legacy Basic Auth выключен по умолчанию (`OPENCODE_AUTH_ALLOW_BASIC=0`) и нужен только старым внешним clients/scripts.

## Оформление и mobile UX

В sidebar `Аккаунт → Настройки` доступны:

- `Системная / Светлая / Тёмная` тема;
- шесть accent presets;
- произвольный accent через color picker;
- сброс оформления.

Настройки хранятся локально в браузере и применяются до первого paint, поэтому theme switching не должен сопровождаться заметной вспышкой старой темы.

Микроанимации используются для dialogs, state surfaces, toast, sidebar, focus/press feedback и progress bars. При `prefers-reduced-motion` они практически отключаются.

На mobile sidebar закрывается swipe справа налево, Back и кликом вне drawer. Панель `Лимиты` сворачивается и запоминает состояние.

Подробнее: [`docs/web-ui.md`](docs/web-ui.md).

## Questions / выбор вариантов

Когда модель вызывает native OpenCode `question`, web client показывает отдельную карточку: single/multi-select, label + description, `Свой вариант…`, несколько вопросов, reject/cancel и PWA notification с deep link.

Ответ отправляется через native question reply API и продолжает остановленный agent loop.

## Project settings и permissions

Кнопка `Project` в header открывает настройки текущей директории:

- persistent instructions — передаются отдельным OpenCode `system` context;
- default orchestrated или конкретная cloud model;
- `RAG: auto/on/off`;
- ordered permission rules `action + resource glob → ask/allow/deny`.

Execution mode в текущем UI фиксирован в Build. Project mode selector скрывается compatibility layer.

Permission card показывается только для текущей session. После ответа она исчезает сразу, а summary объясняет конкретное действие: команда, файл, URL или подзадача; raw payload остаётся под details.

## Changes / Review

Git drawer остаётся основной точкой просмотра изменений, но поверх него добавлен review layer: количество файлов и `+/-` статистика, file diffs, hunks, bounded file/hunk revert и containment внутри project root.

## RAG

RAG полностью опционален. Если `mcp-rag` не найден или явно отключён через `MCP_RAG_ENABLED=0`, installer создаёт рабочий OpenCode config с `kb.disabled=true`.

Когда RAG установлен, `/rag-start` может без LLM-токенов проверить/поднять локальный Qdrant, проверить corpus/index, подключить `kb` к текущему workspace и проверить MCP tools.

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
- [Web UI, авторизация и оформление](docs/web-ui.md)
- [Архитектура и возможности](docs/architecture.md)
- [Модели и routing](docs/models-and-routing.md)
- [Permission control plane](docs/control-plane.md)
- [RAG integration](docs/rag.md)
- [`/rag-start`](docs/rag-start.md)
- [Doctor](docs/doctor.md)
- [Эксплуатация и recovery](docs/operations.md)
- [Troubleshooting](docs/troubleshooting.md)

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
- web UI использует signed HttpOnly session cookie; legacy Basic выключен;
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

OpenCode V2 остаётся изменяющимся upstream, поэтому verifier и host-level Doctor являются частью штатной эксплуатации.
