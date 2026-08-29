# OpenCode web client

Модульный ChatGPT-подобный web/PWA-клиент для OpenCode V2.

Полная пользовательская документация находится в [`../docs/README.md`](../docs/README.md). Этот файл описывает именно `app/` layer.

## Возможности

- root sessions в sidebar; child/subagent sessions скрыты;
- provider limits для Qwen Token Plan и OpenAI/Codex;
- native slash commands и локальные control-команды `/doctor`, `/rag-start`;
- isolated quick-session workspaces;
- `Проекты` → OpenCode projects или безопасный browser папок на host;
- model picker без видимого search field и с группой `Бесплатные модели`;
- rename/delete/fork/duplicate/handoff;
- deep links, parallel running state, Steer/Queue;
- Build/Plan, model/provider/favorites/effort;
- Markdown/code, tool/reasoning renderers, image previews;
- Git/VCS drawer, context/cost widget;
- notifications, draft autosave, files/clipboard images, permissions;
- SSE/status polling и mobile refresh;
- Doctor + zero-token/paid smoke test UI.

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
- `ui-enhancements.css`, `ui-enhancements.js` — free-model grouping + project folder browser;
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

## Бесплатные модели

Видимый model search input отсутствует, поэтому открытие picker на телефоне не должно автоматически поднимать клавиатуру.

Группа `Бесплатные модели` строится по V2 cost metadata, а при его отсутствии — по небольшому fallback списку IDs.

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

Затем проверьте `/doctor`; при настроенном RAG — `/rag-start quick`.
