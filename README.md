# custom_opencode

Переносимый комплект поверх OpenCode V2: собственный ChatGPT-подобный web/PWA client, Alibaba/Qwen routing, серверный Runtime V2/V3 control plane, безопасная работа с локальными проектами, диагностика/self-test и опциональный инженерный RAG через MCP.

## Что предоставляет

### Web/PWA UX

- custom login page вместо browser-native Basic Auth prompt;
- signed `HttpOnly; SameSite=Strict` web sessions, `Запомнить вход`, logout и возврат в исходный `#/session/...` после re-auth;
- root sessions в sidebar и isolated quick-session workspaces;
- Build-only пользовательский execution surface: visible `Build / Plan` switch удалён;
- model picker с favorites, collapsible providers, free-model group и server model profiles;
- одна контекстная кнопка composer: send / cancel / persistent queue;
- native OpenCode questions: single/multi-select, descriptions и custom answer;
- session-scoped compact permission cards и project allow/deny policies;
- Changes/Review: file stats, hunks, safe file/hunk revert;
- orchestration trace, runtime/RAG/queue/status surfaces;
- light / dark / system theme;
- preset и произвольный accent color;
- reduced-motion-aware микроанимации;
- mobile drawer: swipe справа налево, browser/Android Back и tap/click вне панели;
- сворачиваемые provider limits с сохранением состояния;
- Markdown/code/tool/reasoning renderers, files, clipboard images, Git/VCS UI, drafts, notifications и deep links.

### Server Runtime V2/V3

- SQLite/WAL durable task queue с priority, dependencies, cancel, pause/resume и recovery;
- checkpoints, event history, artifacts и per-stage token/cost accounting;
- Task Center и Runtime dashboard;
- model capability registry и server profiles `qwen3.8-coder`, `qwen3.8-orchestrated`, `qwen3.8-review`, fast path;
- adaptive local/cloud routing только внутри явно выбранных auto server profiles;
- AST/symbol repository index, embeddings, dependency graph, bounded Git graph и semantic symbol diff;
- bounded dynamic context + native OpenCode compaction;
- pre-execution read/tool-result cache с Git-aware invalidation;
- large-output artifact storage с range/search;
- structured mailbox, typed handoff и bounded speculative research;
- verification pipeline, failure classifier, review gate, loop/stuck/conflict detection;
- isolated Git worktree tasks, patch ownership и fail-closed merge/cleanup;
- OpenCode-central MCP Code Mode/lazy loading + server policy/rate-limit/health layer;
- scoped Secret Broker и enforced sandbox profiles `safe`, `repo-write`, `docker`, `wsl`, gated `full-machine`;
- session branching, replay без новых model calls, telemetry и remote authenticated task API.

### Knowledge / providers / operations

- Qwen Token Plan и Codex rate-limit sidebar;
- orchestration `Qwen 3.8 Max → Qwen 3.6 Flash fast-reader`;
- optional `mcp-rag` через `kb` MCP;
- `/rag-start` и `/doctor`;
- pre-install verifier, Runtime V2/V3 smokes и post-install zero-LLM-token self-test;
- user systemd deployment и `custom-opencode-update`.

## Build-only UI и model profiles

Пользователь больше не переключает `Build / Plan`: web UI всегда работает в Build. Внутренние OpenCode IDs `plan`/`plan-direct` сохраняются только как upstream compatibility и при попадании в UI переводятся обратно в соответствующий Build profile.

Routing выбирается моделью/profile:

```text
обычная вручную выбранная модель  → build-direct, модель не меняется автоматически
qwen3.8-coder                    → Build + adaptive local/cloud server profile
Qwen 3.8 Max · Оркестрированная  → Build + bounded fast-reader + optional RAG
qwen3.8-review                   → server read/review profile
```

Важно: direct/manual selection не перезаписывается scheduler-ом. Автоматический local/cloud routing существует только для server profile с `route=auto`, а не как скрытая замена любой выбранной модели.

Подробнее: [Модели и routing](docs/models-and-routing.md), [Server Runtime V2](docs/server-runtime-v2.md), [Server Runtime V3](docs/server-runtime-v3.md).

## Composer и durable queue

```text
работы нет                         → ↑ Отправить
работа идёт + composer пустой      → × Отменить текущую работу
работа идёт + есть текст/вложение  → ↑ Отправить в очередь
```

Legacy `/client-queue.json` остаётся compatibility facade. В Runtime V2/V3 queued work хранится в SQLite/WAL, переживает reload/restart и поддерживает priority/dependencies/pause/resume/cancel/checkpoints.

## Авторизация

Обычный web UX использует `/login.html` + `/auth/login`, а не Chrome Basic Auth dialog.

После успешного входа сервер выдаёт подписанную `HttpOnly; SameSite=Strict` cookie. При `Запомнить вход` по умолчанию используется 30-дневный TTL. Password приложением в browser storage не сохраняется.

Если session истекла во время работы, `auth-ui.js` сохраняет полный route, включая `#/session/...`, и после login возвращает пользователя туда же.

Legacy Basic compatibility выключена по умолчанию:

```text
OPENCODE_AUTH_ALLOW_BASIC=0
```

Она нужна только старым внешним clients/scripts.

## Оформление и mobile UX

`Аккаунт → Настройки`:

- `Системная / Светлая / Тёмная`;
- шесть accent presets;
- произвольный accent через color picker;
- reset к default.

Appearance state хранится только в browser storage. Main app применяет `appearance-bootstrap.js` до CSS, поэтому сохранённая тема появляется до первого paint. Accent автоматически получает контрастный foreground.

Микроанимации короткие и используются для dialogs, toast, state surfaces, progress, sidebar и press/focus feedback. `prefers-reduced-motion: reduce` практически отключает motion.

На mobile drawer закрывается swipe справа налево, Back и кликом/тапом вне панели. Панель `Лимиты` сворачивается и запоминает состояние.

Подробнее: [Web UI, авторизация и оформление](docs/web-ui.md).

## Permissions

Permission card показывается только в session, которой принадлежит pending request. После `Разрешить / Отклонить / Всегда` она скрывается сразу, stale polling не должен возвращать уже resolved request.

Краткое описание показывает конкретное действие — command/path/URL/subtask — вместо сырого payload. Полные детали остаются под disclosure.

Server permission control plane остаётся детерминированным. R3/R4 не могут быть понижены model-side или project allow rule.

## Server Runtime V3

```text
Browser / PWA / OpenCode clients
    |
    v
server_workflow.py
    |
    +--> server_runtime.py      durable task lifecycle / queue / verification
    +--> runtime_v3.py          context/index/sandbox/RAG/replay/adaptive routing
    +--> runtime_v3_ext.py      worktree merge / MCP telemetry / runtime APIs
    +--> runtime_completion.py  previews/cache/retry accounting/remote actions
    +--> runtime_store.py       SQLite/WAL state
    +--> permission control plane
    +--> OpenCode V2 backend + central MCP host
```

OpenCode остаётся model/tool/session/MCP execution engine; custom runtime добавляет durable orchestration, policy и host integration вокруг него.

## Project settings

Project state может задавать persistent system instructions, model/profile, RAG policy и ordered permission rules. Visible execution mode всё равно Build — старый mode field остаётся только compatibility data.

Folder browser ограничен `OPENCODE_PROJECT_ROOTS` и canonical/symlink containment.

## RAG

RAG опционален. При `MCP_RAG_ENABLED=0` или отсутствии usable `mcp-rag` обычные OpenCode/runtime workflows продолжают работать.

`/rag-start` может без LLM inference проверить/поднять локальный Qdrant, corpus/index, подключить `kb` к текущему workspace и проверить MCP tools.

## Быстрый старт

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

Полный индекс: [docs/README.md](docs/README.md).

Основные разделы:

- [Установка, миграция и обновление](docs/installation.md)
- [Конфигурация `.env`](docs/configuration.md)
- [Web UI, авторизация и оформление](docs/web-ui.md)
- [Архитектура и возможности](docs/architecture.md)
- [Server Runtime V2](docs/server-runtime-v2.md)
- [Server Runtime V3](docs/server-runtime-v3.md)
- [Модели и routing](docs/models-and-routing.md)
- [Permission control plane](docs/control-plane.md)
- [RAG integration](docs/rag.md)
- [`/rag-start`](docs/rag-start.md)
- [Doctor](docs/doctor.md)
- [Эксплуатация и recovery](docs/operations.md)
- [Troubleshooting](docs/troubleshooting.md)

## Security defaults

- secrets/host URLs только в private `.env`/trusted service boundary;
- signed HttpOnly web session; legacy Basic off by default;
- recommended web bind — loopback или защищённый tailnet/reverse proxy;
- project/scratch containment;
- R0–R4 permission floor;
- direct manual model selection не меняется auto scheduler-ом;
- scoped secrets не сериализуются в browser/runtime snapshots;
- sandbox/worktree ownership checks до writable execution;
- auth/API/HTML responses не кэшируются service worker как offline app shell;
- install/update fail closed при critical self-test failure.
