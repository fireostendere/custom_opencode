# OpenCode web client

Модульный ChatGPT-подобный web/PWA-клиент для OpenCode V2.

## Возможности

- root-сессии в sidebar; child/subagent sessions скрыты;
- sidebar limits для Qwen Token Plan и OpenAI/Codex;
- native slash commands `/...` с hints;
- isolated quick-session workspaces;
- `Проекты` → известные OpenCode проекты или безопасный browser папок на ПК;
- model picker без видимого search input и с отдельной группой `Бесплатные модели`;
- rename/delete/fork/duplicate/handoff;
- deep links, parallel running state, Steer/Queue;
- Build/Plan, model/provider/favorites/effort;
- Markdown/code, tool/reasoning renderers, image previews;
- Git/VCS drawer и context/cost widget;
- notifications, draft autosave, files/clipboard images, permissions;
- SSE + status polling и mobile pull-down refresh.

## Структура

- `index.html` — application shell;
- `styles.css` — основной UI;
- `enhancements.css`, `enhancements.js` — provider limits + slash palette;
- `ui-enhancements.css`, `ui-enhancements.js` — free-model grouping + project folder browser;
- `api.js` — OpenCode HTTP adapter/fallbacks;
- `markdown.js` — Markdown/code renderer;
- `app.js` — session store/event/UI orchestration;
- `sw.js` — PWA cache/notifications;
- `server.py` — authenticated proxy + isolated quick workspaces;
- `server_ext.py` — Qwen/OpenAI rate-limit bridges;
- `server_plus.py` — constrained host-directory browser поверх `server_ext.py`.

## Бесплатные модели

В model picker нет видимого текстового поиска, поэтому открытие окна на телефоне не должно поднимать клавиатуру.

Группа `Бесплатные модели` строится в первую очередь по V2 cost metadata: все input/output/cache costs должны быть нулевыми. Если конкретный beta build не возвращает cost metadata, используется небольшой fallback по free model ID. Это не превращает текущий список бесплатных моделей в жёстко зашитый catalog.

## Открытие проекта/папки

Кнопка `Проекты` сохраняет обычный список `/api/project` и добавляет `Папки на ПК`.

`/client-directories.json`:

- доступен только после той же web-auth проверки;
- разрешает навигацию только внутри `OPENCODE_PROJECT_ROOTS`;
- canonicalizes пути и не допускает symlink escape;
- отдаёт только имена/пути директорий, не содержимое файлов;
- скрывает dot-directories;
- ограничивает листинг 250 директориями за запрос.

`Открыть эту папку` создаёт новую OpenCode session с `location.directory` выбранной директории.

## Лимиты провайдеров

OpenAI/Codex: `server_ext.py` запускает локальный `codex app-server`, выполняет `account/rateLimits/read` и отдаёт браузеру только нормализованные окна/remaining/reset без OAuth credentials.

Qwen/Alibaba: `bl usage token-plan --output json` даёт долю использованного 5h/7d окна и reset. UI показывает remaining % и примерный остаток Credits относительно caps Personal Pro. При недоступном Bailian CLI остаётся безопасный caps/probe fallback.

Кэш default 60 секунд. Переопределения: `CODEX_BIN`, `BAILIAN_CLI_BIN`, `OPENCODE_LIMITS_CACHE_SECONDS`.

## Slash-команды

Команды загружаются через context-aware `GET /api/command`; выполнение — native `POST /api/session/:id/command` с `command` и `arguments`.

UX: `/` открывает список; ввод фильтрует; `↑/↓` выбирают; `Tab` подставляет; точное имя + `Enter` выполняет. `//text` отправляет обычный `/text` prompt.

## Запуск

Обычно через systemd/install script. Ручной запуск:

```bash
python3 server_plus.py
```

Основные env:

- `OPENCODE_WEB_HOST`, `OPENCODE_WEB_PORT`;
- `OPENCODE_BACKEND_URL`, `OPENCODE_BACKEND_PASSWORD`;
- `OPENCODE_SCRATCH_DIRECTORY`;
- `OPENCODE_PROJECT_ROOTS`;
- `CODEX_BIN`, `BAILIAN_CLI_BIN`;
- `OPENCODE_LIMITS_CACHE_SECONDS`.

## Beta caveat

OpenCode V2 остаётся beta. После upstream update следует прогонять `scripts/verify.sh` и runtime smoke для session API, project folder opening, model picker, commands и MCP.
