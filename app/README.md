# OpenCode web client

Модульный ChatGPT-подобный web/PWA-клиент для OpenCode V2.

Полная пользовательская документация находится в [`../docs/README.md`](../docs/README.md). Этот файл описывает именно `app/` layer.

## Возможности

- root sessions в sidebar; child/subagent sessions скрыты из sidebar;
- provider limits для Qwen Token Plan и OpenAI/Codex, панель лимитов сворачивается и запоминает состояние;
- custom login вместо browser-native auth prompt;
- signed HttpOnly web sessions с `Запомнить вход`, logout и возвратом в исходный `#/session/...` после re-auth;
- mobile drawer: swipe справа налево, Back и tap/click вне панели;
- light/dark/system theme, preset/custom accent color и сохранение оформления в браузере;
- reduced-motion-aware microanimations;
- native slash commands и локальные control-команды `/doctor`, `/rag-start`;
- isolated quick-session workspaces;
- `Проекты` → OpenCode projects или безопасный browser папок на host;
- Build-only пользовательский execution surface;
- model picker с favorites, сортировкой, collapsible providers и отдельной группой бесплатных моделей;
- `Qwen 3.8 Max · Оркестрированная` как model profile;
- contextual composer action вместо двух кнопок и ручного `Steer/Queue`;
- server-backed persistent queue с reorder/delete;
- native question cards: single/multiple choice + custom text answer;
- compact session-scoped permission banner + project permission policy;
- Project settings с system instructions/model/RAG/permission defaults;
- Changes/Review с file/hunk diffs и safe revert;
- expandable orchestration tree с child sessions/RAG marker;
- compact workflow status bar;
- rename/delete/fork/duplicate/handoff;
- Markdown/code, tool/reasoning renderers, image previews;
- Git/VCS drawer, context/cost widget;
- actionable notifications, draft autosave, files/clipboard images;
- SSE/status polling и mobile refresh;
- Doctor + zero-token/paid smoke test UI.

Локальные Ollama models остаются manual-only возможностью model picker. Workflow layer не выбирает local provider программно, не запускает и не выгружает local runtime и не анализирует GPU/игры для model routing.

## Web auth

`server.py` отдаёт `/login.html` как публичную entry page. Обычные HTML requests без сессии получают redirect на login; API/client requests — JSON `401`.

После `/auth/login` сервер выдаёт подписанную `HttpOnly; SameSite=Strict` cookie. При `Запомнить вход` добавляется долгий `Max-Age`. Password приложением в localStorage не сохраняется.

`auth-ui.js` перехватывает same-origin `401`, сохраняет полный текущий route в sessionStorage и после повторного входа возвращает пользователя в тот же session.

Legacy Basic Auth отключён по умолчанию и включается только через `OPENCODE_AUTH_ALLOW_BASIC=1` для старых clients/scripts.

## Composer state machine

Пользователь не выбирает delivery mode вручную:

```text
idle                         → ↑ send
running + empty composer     → × cancel
running + text/attachment    → ↑ persistent queue
```

Старые native `send`, `stop`, `Steer/Queue` controls остаются внутренним compatibility layer для существующего `app.js`, но скрыты из UI.

## Model profiles и Build-only UX

Visible mode switch удалён. Текущая session всегда приводится к Build profile:

```text
обычная модель                    → build-direct
Qwen 3.8 Max · Оркестрированная   → build
```

Если старый state активировал `plan`/`plan-direct`, `access-fix.js` переводит его обратно в соответствующий Build agent. Project mode selector также скрывается и фиксируется в `build`.

Обычный выбор локальной модели остаётся ручным ordinary-model choice и не связан с Project defaults или persistent queue routing.

## Appearance

`appearance.js` хранит только `{theme, accent}` в `opencode:web:appearance-v1` и применяет:

- `system`, `light`, `dark`;
- шесть preset accent colors;
- custom color picker;
- автоматический contrast foreground;
- live follow системной темы.

`appearance.css` загружен последним и переводит legacy dark surfaces на общую palette. Login page читает то же preference inline до первого paint, не требуя auth-protected assets.

Microanimations используются для dialogs, permission/question/status surfaces, toast, sidebar, focus/press feedback и progress bars. `prefers-reduced-motion` отключает motion.

## Mobile drawer

`mobile-ui.js` создаёт scrim и synthetic history entry. Drawer закрывается:

- повторным menu click;
- tap/click по scrim или любому target вне sidebar;
- swipe справа налево;
- Android/browser Back.

При выборе session служебная history entry потребляется до навигации, поэтому лишний Back не остаётся.

## Permissions

`access-fix.js` повторно получает native permission requests и показывает только request текущего `sessionID`. После ответа карточка скрывается немедленно; resolved key временно блокирует stale polling result.

Summary строится из action metadata (`command`, `path`, `URL`, `prompt`), а полный payload остаётся под details.

## Native questions

`advanced-features.js` опрашивает native OpenCode question requests и отображает отдельную карточку: single/multi-select, descriptions, custom text и native reply/reject.

## Project settings

Server state привязан к canonical project directory. UI хранит persistent instructions, model profile, RAG preference и permission rules. Execution mode в текущем UX всегда Build.

Project defaults не могут автоматически выбрать `ollama/*`. Persistent instructions передаются через `system` field current OpenCode message API.

## Persistent queue

Очередь хранится сервером в `$XDG_STATE_HOME/custom-opencode/web-features.json` или `~/.local/state/custom-opencode/web-features.json`.

Фоновый worker ждёт idle, отправляет следующий prompt через уже выбранную для session модель и удаляет item только после успешного принятия backend. Queue worker model/provider не меняет.

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

- `server.py` — custom web session auth + proxy + isolated quick workspaces;
- `server_ext.py` — Qwen/OpenAI rate-limit bridges;
- `server_plus.py` — constrained host-directory browser + Doctor endpoints;
- `server_rag.py` — `/rag-start`, V2 MCP workspace connect и persisted RAG enablement;
- `server_features.py` — persistent queue/project policy/git revert;
- `server_workflow.py` — production composition + project system-context send path.

## Frontend modules

- `index.html` — application shell + appearance settings dialog;
- `styles.css` — основной legacy UI;
- `appearance.css`, `appearance.js` — theme/accent/microanimations;
- `login.html`, `login.css`, `login.js`, `auth-ui.js`, `auth.css` — web session UX;
- `mobile-ui.js`, `sidebar-mobile.css` — mobile drawer lifecycle;
- `enhancements.css`, `enhancements.js` — provider limits + slash palette;
- `ui-enhancements.css`, `ui-enhancements.js` — model catalog + project folder browser;
- `ux-controls.css`, `ux-controls.js`, `ux-state.js` — model profile/composer compatibility;
- `access-fix.css`, `access-fix.js` — Build-only/permission/mobile dialog corrections;
- `advanced-features.css`, `advanced-features.js` — persistent queue, questions, project settings, orchestration trace, advanced review;
- `rag-control.js` — client-side `/rag-start` interception/control;
- `doctor.css`, `doctor.js` — diagnostics UI;
- `api.js` — OpenCode HTTP adapter/fallbacks;
- `markdown.js` — Markdown/code renderer;
- `app.js` — session store/event/UI compatibility core;
- `sw.js` — PWA static cache/notifications; HTML/auth responses не кэшируются.

## Проверка

После upstream OpenCode V2 changes:

```bash
../scripts/verify.sh
```

Verifier проверяет JavaScript/Python syntax, web smoke, provider/Doctor smoke и zero-token workflow invariants. Для визуальных изменений дополнительно проверяйте light/dark/system, reduced-motion, mobile drawer и re-auth возврат в session.
