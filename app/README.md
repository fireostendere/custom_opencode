# OpenCode web client

Модульный ChatGPT-подобный web/PWA-клиент для OpenCode V2.

Полная пользовательская документация находится в [`../docs/README.md`](../docs/README.md). Этот файл описывает именно `app/` layer.

## Возможности

- root sessions в sidebar; child/subagent sessions скрыты из sidebar;
- provider limits для Qwen Token Plan и OpenAI/Codex;
- native slash commands и локальные control-команды `/doctor`, `/rag-start`;
- isolated quick-session workspaces;
- `Проекты` → OpenCode projects или безопасный browser папок на host;
- только `Build / Plan` как пользовательские mode controls;
- model picker с favorites, сортировкой, collapsible providers и отдельной группой бесплатных моделей;
- `Qwen 3.8 Max · Оркестрированная` как model profile;
- contextual composer action вместо двух кнопок и ручного `Steer/Queue`;
- server-backed persistent queue с reorder/delete;
- native question cards: single/multiple choice + custom text answer;
- compact permission banner + project permission policy;
- Project settings с system instructions/defaults/RAG policy;
- Changes/Review с file/hunk diffs и safe revert;
- expandable orchestration tree с child sessions/RAG marker;
- compact workflow status bar;
- rename/delete/fork/duplicate/handoff;
- deep links и parallel running state;
- Markdown/code, tool/reasoning renderers, image previews;
- Git/VCS drawer, context/cost widget;
- actionable notifications, draft autosave, files/clipboard images, permissions;
- SSE/status polling и mobile refresh;
- Doctor + zero-token/paid smoke test UI.

Локальные Ollama models остаются существующей manual-only возможностью обычного model picker. Advanced workflow layer не выбирает local provider программно, не запускает и не выгружает local runtime и не анализирует GPU/игры для model routing.

## Composer state machine

Пользователь не выбирает delivery mode вручную:

```text
idle                         → ↑ send
running + empty composer     → × cancel
running + text/attachment    → ↑ persistent queue
```

Старые native `send`, `stop`, `Steer/Queue` controls остаются внутренним compatibility layer для существующего `app.js`, но скрыты из UI. `ux-controls.js` синхронизирует единственную видимую кнопку, а `advanced-features.js` перехватывает queued submit и сохраняет его сервером.

## Model profiles

Видимыми execution modes остаются только `Build` и `Plan`.

```text
обычная модель + Build   → build-direct
обычная модель + Plan    → plan-direct
Оркестрированная + Build → build
Оркестрированная + Plan  → plan
```

Обычный выбор локальной модели в model picker по-прежнему является ручным ordinary-model choice и не связан с Project defaults или persistent queue routing.

## Native questions

`advanced-features.js` опрашивает native OpenCode question requests и отображает их отдельной карточкой над composer:

- один или несколько вопросов;
- single/multi-select;
- option descriptions;
- custom text для каждого вопроса;
- reply/reject через native question API;
- notification/deep link при ожидании ответа.

Это не текстовая имитация `1/2/3`: agent loop получает настоящий question reply и продолжает выполнение.

## Project settings

Server state привязан к canonical project directory. UI хранит:

- persistent instructions;
- default Build/Plan;
- default orchestrated или конкретную cloud model;
- RAG preference;
- permission rules.

Project defaults намеренно не могут автоматически выбрать `ollama/*`. Persistent instructions передаются через `system` field current OpenCode message API и не отображаются внутри user message. Для старого несовместимого backend остаётся prompt compatibility fallback.

## Persistent queue

Очередь хранится в `server_features.py`, по умолчанию в `$XDG_STATE_HOME/custom-opencode/web-features.json` или `~/.local/state/custom-opencode/web-features.json`.

Фоновый worker production web server:

1. проверяет status queued session;
2. ждёт idle;
3. отправляет следующий prompt через OpenCode API с уже выбранной для session моделью;
4. удаляет item только после успешного принятия backend.

Queue worker никогда не меняет model/provider. Поэтому вкладка/PWA не обязана оставаться открытой, а ручной local-model выбор не превращается в automatic routing.

## Permission policy

Project rules имеют форму:

```text
action glob + resource glob → ask | allow | deny
```

`Разрешать в проекте` на permission card создаёт точечное allow-rule из текущего action/resource. Worker применяет allow/deny к pending permission requests. Глобальное backend `Always` остаётся доступным, но не требуется для типовых project exceptions.

## Changes / Review

Базовый Git drawer остаётся источником VCS status/session diff. Advanced layer добавляет:

- `files / + / -` summary;
- diff per file;
- hunks;
- revert tracked file через `git restore --worktree`;
- removal только конкретного untracked file;
- hunk reverse apply;
- canonical path containment внутри разрешённого project root.

## Orchestration tree и status bar

Child sessions всё ещё не засоряют sidebar. Они отображаются внутри раскрываемого execution trace текущей root session. Для child показываются agent/model/status/time и RAG marker, если в child trace виден knowledge tool.

Status bar показывает компактно model/profile, context, cost, elapsed time, RAG и persistent queue count.

## Server stack

```text
server.py
  └── server_ext.py
        └── server_plus.py
              ├── server_rag.py
              └── server_features.py
                    ↓ composition
                server_workflow.py   ← production entrypoint
```

- `server.py` — authenticated proxy + isolated quick workspaces;
- `server_ext.py` — Qwen/OpenAI rate-limit bridges;
- `server_plus.py` — constrained host-directory browser + Doctor endpoints;
- `server_rag.py` — `/rag-start`, V2 MCP workspace connect и persisted RAG enablement;
- `server_features.py` — persistent queue/project policy/git revert;
- `server_workflow.py` — production composition + project system-context send path.

## Frontend modules

- `index.html` — application shell;
- `styles.css` — основной UI;
- `enhancements.css`, `enhancements.js` — provider limits + slash palette;
- `ui-enhancements.css`, `ui-enhancements.js` — model catalog + project folder browser;
- `ux-controls.css`, `ux-controls.js`, `ux-state.js` — Build/Plan, direct/orchestrated profiles, contextual composer, permission summary;
- `advanced-features.css`, `advanced-features.js` — persistent queue, questions, project settings, orchestration trace, advanced review;
- `rag-control.js` — client-side `/rag-start` interception/control;
- `doctor.css`, `doctor.js` — diagnostics UI;
- `api.js` — OpenCode HTTP adapter/fallbacks;
- `markdown.js` — Markdown/code renderer;
- `app.js` — session store/event/UI orchestration compatibility core;
- `sw.js` — PWA cache/notifications.

## Folder browser

`/client-directories.json`:

- требует ту же web-auth;
- ограничен `OPENCODE_PROJECT_ROOTS`;
- canonicalizes paths;
- блокирует symlink escape;
- отдаёт только directories;
- скрывает dot-directories;
- ограничивает listing.

Browser намеренно не содержит raw path text input.

## Slash/control commands

Native OpenCode commands загружаются через `/api/command` и выполняются native session command API.

`/doctor` и `/rag-start` — host-local controls, они не должны уходить модели как обычный prompt.

`//text` позволяет отправить обычное сообщение, начинающееся с `/`.

## Проверка

После upstream OpenCode V2 changes:

```bash
../scripts/verify.sh
```

Verifier проверяет JavaScript/Python syntax, web smoke, provider/Doctor smoke и zero-token workflow smoke: persistent settings/queue, запрет automatic local defaults и safe Git revert.
