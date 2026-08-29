# OpenCode web client

Модульный ChatGPT-подобный web/PWA-клиент для OpenCode V2.

Полная пользовательская документация находится в [`../docs/README.md`](../docs/README.md). Этот файл описывает именно `app/` layer.

## Возможности

- root sessions в sidebar; child/subagent sessions скрыты;
- provider limits для Qwen Token Plan и OpenAI/Codex;
- native slash commands и локальные control-команды `/doctor`, `/rag-start`;
- isolated quick-session workspaces;
- `Проекты` → OpenCode projects или безопасный browser папок на host;
- только `Build / Plan` как пользовательские mode controls;
- model picker без visible search input, с favorites, сортировкой, collapsible providers и отдельной группой бесплатных моделей;
- `Qwen 3.8 Max · Оркестрированная` выбирается как model profile прямо в picker;
- contextual composer action вместо двух кнопок и ручного `Steer/Queue`;
- compact permission banner с коротким summary и details под раскрытием;
- rename/delete/fork/duplicate/handoff;
- deep links и parallel running state;
- Markdown/code, tool/reasoning renderers, image previews;
- Git/VCS drawer, context/cost widget;
- notifications, draft autosave, files/clipboard images, permissions;
- SSE/status polling и mobile refresh;
- Doctor + zero-token/paid smoke test UI.

## Composer state machine

Пользователь не выбирает delivery mode вручную:

```text
idle                         → ↑ send
running + empty composer     → × cancel
running + text/attachment    → ↑ queue
```

Старые native `send`, `stop`, `Steer/Queue` controls остаются внутренним compatibility layer для существующего `app.js`, но скрыты из UI. `ux-controls.js` синхронизирует единственную видимую кнопку с фактическим session state.

## Model picker

Picker сохраняет существующий `opencode:web:favorites` state. Favorite toggle не выбирает модель; после изменения список пересортируется.

Каталог:

- `Бесплатные модели` — отдельная collapsible group;
- остальные модели группируются по provider;
- provider sections можно сворачивать, состояние хранится локально;
- внутри группы сначала favorites, затем выбранная модель, затем alphabetical sort;
- `Qwen 3.8 Max · Оркестрированная` добавляется как отдельный model profile рядом с Alibaba models;
- обычный `Qwen3.8 Max` остаётся обычным direct model choice.

## Build / Plan и model profiles

Видимыми остаются только `Build` и `Plan`.

`Build` означает обычное выполнение задачи выбранной моделью. `Plan` сохраняет выбранную модель/profile, но запрещает edit и shell.

Оркестрация выбирается не отдельной mode-кнопкой, а специальной моделью `Qwen 3.8 Max · Оркестрированная`.

Внутри config существуют четыре technical primary agent ID:

```text
обычная модель + Build   → build-direct
обычная модель + Plan    → plan-direct
Оркестрированная + Build → build
Оркестрированная + Plan  → plan
```

Эти ID являются implementation detail и не должны показываться пользователю как дополнительные режимы.

## Permission cards

Большой permission payload больше не растягивает всю нижнюю часть экрана. На поверхности показываются action type и короткий извлечённый hint максимум в две строки; raw resources/body находятся в `Показать детали` с bounded scroll area.

## Server stack

```text
server.py
  └── server_ext.py
        └── server_plus.py
              └── server_rag.py
```

- `server.py` — authenticated proxy + isolated quick workspaces;
- `server_ext.py` — Qwen/OpenAI rate-limit bridges;
- `server_plus.py` — constrained host-directory browser + Doctor endpoints;
- `server_rag.py` — `/rag-start`, V2 MCP workspace connect и persisted RAG enablement.

Production/user systemd unit запускает `server_rag.py`.

## Frontend modules

- `index.html` — application shell;
- `styles.css` — основной UI;
- `enhancements.css`, `enhancements.js` — provider limits + slash palette;
- `ui-enhancements.css`, `ui-enhancements.js` — model catalog + project folder browser;
- `ux-controls.css`, `ux-controls.js`, `ux-state.js` — Build/Plan surface, model-selected orchestration, contextual composer и permission summary;
- `rag-control.js` — client-side `/rag-start` interception/control;
- `doctor.css`, `doctor.js` — diagnostics UI;
- `api.js` — OpenCode HTTP adapter/fallbacks;
- `markdown.js` — Markdown/code renderer;
- `app.js` — session store/event/UI orchestration;
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

## Provider limits

OpenAI/Codex: локальный `codex app-server` RPC `account/rateLimits/read`.

Qwen/Alibaba: `bl usage token-plan --output json`.

Browser получает только нормализованные usage/reset данные.

## Ручной запуск для разработки

Обычно используйте installer/systemd. Если нужен ручной запуск актуального полного server stack:

```bash
python3 server_rag.py
```

Не используйте `server_plus.py` как production entrypoint: он не включает `/rag-start` lifecycle layer.

## Проверка

После upstream OpenCode V2 changes:

```bash
../scripts/verify.sh
```

Затем проверьте `Build/Plan`, model picker, три состояния composer, permission card, `/doctor`; при настроенном RAG — `/rag-start quick`.
