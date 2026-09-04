# OpenCode web client

Модульный ChatGPT-подобный web/PWA-клиент и server control layer для OpenCode V2.

Полная документация: [`../docs/README.md`](../docs/README.md).

## Web/PWA

- root sessions в sidebar; child/subagent sessions — в orchestration trace;
- custom login вместо browser-native Basic Auth prompt;
- signed HttpOnly sessions с `Запомнить вход`, logout и возвратом в исходный `#/session/...` после re-auth;
- provider limits для Qwen Token Plan и OpenAI/Codex; панель сворачивается и запоминает состояние;
- mobile drawer: swipe справа налево, Back и tap/click вне панели;
- light/dark/system theme, preset/custom accent color;
- short reduced-motion-aware microanimations;
- native slash commands и control-команда `/rag-start`;
- isolated quick-session workspaces и безопасный browser локальных project roots;
- web всегда использует `Build`, native `Plan` остаётся доступен в TUI;
- web- и TUI-model picker с зеркальной секцией favorites, collapsible providers, free-model group, ordinary models и server profiles;
- model и effort берутся из активной сессии, а не из предыдущего открытого диалога;
- сессию можно скопировать с контекстом либо перенести через handoff в другой проект; UI предупреждает об ограничении в 40 текстовых сообщений / 24 000 символов и удаляет источник только после успешного handoff;
- contextual composer action: send / cancel / durable queue;
- native question cards, compact session-scoped permission banner, project policies;
- Project settings: system instructions/model profile/RAG/permission defaults;
- Changes/Review, file/hunk revert, orchestration trace и workflow/runtime status;
- Markdown/code, images/files, Git/VCS, drafts, notifications;
- постоянно доступная панель `Инструменты и агенты` для tool/reasoning events.

## Web Build, TUI Plan и routing

В web переключатель режима скрыт: direct-профиль всегда использует `build-direct` (или native `build`), orchestrated-профиль — native `build`. Native `plan`/`plan-direct` остаются доступны в TUI и CLI. Selected provider/model/variant сохраняется.

Обычная модель из model picker остаётся direct/manual selection:

```text
ordinary selected model → build-direct/native build → selected model preserved
```

Runtime V2/V3 дополнительно предлагает server profiles:

```text
direct                 → выбранная модель, scheduler не меняет её
qwen3.8-orchestrated   → cloud Max + bounded orchestration/fast-reader/RAG
gpt-5.6-sol-orchestrated → SOL orchestration на официальном OpenAI provider
```

Provider-pinned orchestration доступна только через явные alias-профили. Ручная Ollama/Qwen/OpenAI model selection не должна быть незаметно заменена scheduler-ом.

## Composer и task runtime

UI state machine:

```text
idle                         → ↑ send
running + empty composer     → × cancel
running + text/attachment    → ↑ queue
```

Legacy `/client-queue.json`/feature-state сохраняются как compatibility facade. Runtime V2/V3 использует SQLite/WAL tasks, checkpoints, events, artifacts, dependencies, priority, pause/resume/cancel и recovery.

`runtime-dashboard.js` добавляет server profile badge и Task Center. `runtime-v3-dashboard.js` добавляет V3 status/search/control surface. Оба dashboard остаются внутри общего theme layer.

## Web auth

`server.py` публикует `/login.html`, `/login.css`, `/login.js` и auth endpoints. Неавторизованный HTML получает redirect на login; API/client endpoints — JSON `401` без `WWW-Authenticate`.

После `/auth/login` сервер выдаёт signed `HttpOnly; SameSite=Strict` cookie. `Secure` определяется HTTPS/reverse-proxy settings. `Запомнить вход` меняет TTL cookie; password приложением в browser storage не сохраняется.

`auth-ui.js` ловит same-origin `401`, сохраняет полный route в sessionStorage и после login возвращает пользователя в ту же session.

Legacy Basic Auth выключен по умолчанию (`OPENCODE_AUTH_ALLOW_BASIC=0`) и предназначен только для старых внешних clients/scripts.

## Appearance

`appearance.js` хранит `{theme, accent}` в `opencode:web:appearance-v1`:

- `system`, `light`, `dark`;
- preset/custom accent;
- automatic contrast foreground;
- live follow `prefers-color-scheme`.

`appearance-bootstrap.js` запускается синхронно из `<head>` до CSS, поэтому persisted theme применяется до первого paint. `appearance.css` покрывает legacy UI, а `appearance-runtime.css` — Runtime V2/V3 dashboards.

Microanimations используются для dialogs, permission/question/status surfaces, toast, drawer, focus/press и progress. `prefers-reduced-motion` почти полностью отключает motion.

## Mobile drawer

`mobile-ui.js` создаёт scrim и synthetic history entry. Drawer закрывается:

- повторным menu click;
- tap/click по scrim или любому target вне sidebar;
- swipe справа налево;
- Android/browser Back.

При выборе session synthetic history entry потребляется до навигации.

## Permissions

`access-fix.js` показывает только pending permission текущего `sessionID`. После ответа карточка исчезает немедленно, а временный resolved-key suppression не позволяет stale poll вернуть её обратно.

Summary извлекает понятные `command/path/URL/prompt`, raw payload остаётся под details.

Server-side R0–R4 control plane остаётся финальной risk boundary.

## Server stack

Production composition включает legacy web/features и Runtime V2/V3:

```text
server.py
  └── server_ext.py
        └── server_plus.py
              ├── server_rag.py
              └── server_features.py
                    └── server_control.py / server_runtime.py
                          └── server_workflow.py  ← systemd entrypoint
```

Runtime modules:

- `runtime_store.py` — SQLite/WAL tasks/checkpoints/events/usage/mailbox;
- `model_registry.py` — model capabilities, server profiles, adaptive scheduler;
- `repo_services.py` — repo index/context/artifacts/verification/secrets;
- `runtime_resume.py` — checkpoint continuation policy;
- `runtime_v3.py`, `runtime_v3_ext.py`, `runtime_completion.py` — V3 context/index/cache/sandbox/worktree/replay/telemetry/completion layers;
- `server_runtime.py` — runtime APIs and task lifecycle integration.

OpenCode V2 остаётся native model/tool/session/MCP execution engine.

## Frontend modules

- `index.html` — app shell + appearance settings dialog;
- `styles.css` — core legacy UI;
- `appearance-bootstrap.js`, `appearance.js`, `appearance.css`, `appearance-runtime.css` — theme/accent/motion;
- `login.*`, `auth-ui.js`, `auth.css` — web session UX;
- `mobile-ui.js`, `sidebar-mobile.css` — mobile drawer lifecycle;
- `enhancements.*`, `ui-enhancements.*`, `ux-controls.*`, `advanced-features.*` — UI/features compatibility layers;
- `runtime-dashboard.*`, `runtime-v3-dashboard.*` — Task Center/Runtime V3 controls;
- `access-fix.*` — web Build/permissions/mobile dialog corrections;
- `design-system.css`, `sidebar-resize.js` — единая геометрия/chevrons, адаптивные dialog scroll surfaces и desktop resize sidebar;
- `rag-control.js`, `control-plane.*` — RAG/risk surfaces;
- `api.js`, `markdown.js`, `app.js` — OpenCode adapter/render/store core;
- `sw.js` — PWA static asset cache/notifications; HTML/auth/API/internal runtime responses не кэшируются.

## Проверка

```bash
../scripts/verify.sh
../scripts/verify-runtime-v3.sh
```

Verifier включает JS/Python syntax, web smoke, runtime/RAG/limits smokes и source invariants. Для визуальных изменений дополнительно проверяйте light/dark/system, reduced-motion, mobile drawer и re-auth route restoration.
