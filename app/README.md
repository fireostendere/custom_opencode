# OpenCode web client

Модульный ChatGPT-подобный web/PWA-клиент для OpenCode V2.

## Возможности

- корневые сессии сервера в sidebar; дочерние subagent-сессии скрыты;
- вверху sidebar — лимиты Qwen и OpenAI: Qwen читает реальные 5h/7d проценты и reset через `bl usage token-plan --output json`, OpenAI — реальные окна через Codex app-server `account/rateLimits/read`;
- slash-команды: ввод `/` открывает контекстный список `/api/command`, Tab/Enter выбирают команду, submit вызывает `/api/session/:id/command`; `//` экранирует slash и отправляется как обычный текст;
- поиск, стабильная группировка по project ID, pin и archive;
- rename, delete, Duplicate/Fork и fork от конкретного сообщения;
- hash deep-links `#/session/<id>`: refresh и Back/Forward сохраняют выбранную сессию;
- быстрые сессии получают отдельный filesystem workspace внутри `OPENCODE_SCRATCH_DIRECTORY`;
- quick → project handoff: текущий контекст переносится в новую сессию выбранного проекта;
- параллельные running-сессии: можно уйти в другой чат, пока агент продолжает работу;
- во время выполнения доступны Steer и локальная Queue следующего сообщения;
- Build/Plan, выбор модели, provider grouping, favorites и effort;
- Markdown, таблицы, ссылки, fenced code, базовая syntax highlighting и Copy;
- отдельные renderer-ы reasoning/tool calls, shell/file operations, diff и image previews;
- Git/VCS drawer: branch, tracked file status, session/VCS diff и чтение изменённых файлов;
- context/token/cost widget с model context limit;
- browser/PWA notifications о завершении фоновой сессии и permission request;
- текст draft автоматически сохраняется по session ID в localStorage;
- файлы добавляются кнопкой `+`, изображения можно вставлять из clipboard;
- permissions можно принять/отклонить из браузера;
- SSE обновляет reasoning/tools без перезагрузки; session status дополнительно сверяется polling-ом;
- pull-down refresh сохранён для мобильного режима.

## Структура

- `index.html` — application shell;
- `styles.css` — основной UI и responsive layout;
- `enhancements.css` — sidebar limits и slash palette;
- `api.js` — OpenCode HTTP adapter и compatibility fallbacks;
- `markdown.js` — безопасный Markdown/code renderer;
- `app.js` — session store, event stream и UI orchestration;
- `enhancements.js` — provider-limit UI и slash-command bridge;
- `sw.js` — PWA runtime cache и notification surface;
- `server.py` — same-origin authenticated proxy и isolated quick workspaces;
- `server_ext.py` — поверх proxy добавляет безопасный `/client-limits.json`, Codex app-server и Bailian CLI rate-limit bridges.

## Лимиты провайдеров

OpenAI/Codex: `server_ext.py` запускает локальный `codex app-server`, выполняет официальный RPC `account/rateLimits/read`, берёт `usedPercent`, длительность окна и `resetsAt`, после чего отдаёт браузеру только нормализованный rate-limit snapshot. Email, токены авторизации и другие данные аккаунта в браузер не передаются.

Qwen/Alibaba: `server_ext.py` запускает официальный `bl usage token-plan --output json`. Команда возвращает долю использованного 5-часового и недельного окна и их reset timestamps. Для Personal Pro UI переводит это в remaining %, а также показывает примерный остаток Credits относительно caps `12 000 / 5h` и `40 000 / 7d`. Если Bailian CLI недоступен или не авторизован для Token Plan usage, UI откатывается к caps и существующему Qwen probe (`OK`/`exhausted`).

Оба источника кэшируются на 60 секунд по умолчанию. Если `codex` или `bl` не находятся через PATH/стандартные user-bin каталоги, пути можно явно задать через `CODEX_BIN` и `BAILIAN_CLI_BIN`. TTL задаётся `OPENCODE_LIMITS_CACHE_SECONDS`.

## Slash-команды

Команды загружаются для текущей directory через `GET /api/command`. При выборе команды браузер вызывает native OpenCode `POST /api/session/:id/command` с `command` и `arguments`, то есть это именно command path OpenCode, а не prompt, замаскированный под `/команду`.

UX: одиночный `/` открывает палитру; ввод после `/` фильтрует список; `↑/↓` меняют выделение; `Tab` подставляет команду; `Enter` на точном имени выполняет её, а на неполном имени сначала подставляет выбранную подсказку. `//текст` отправляется как обычное сообщение `/текст`.

Если сессия ещё не создана, перед выполнением команды UI создаёт обычную isolated quick-сессию. Для команд, которые должны работать в конкретном репозитории, сначала выберите/создайте project-session. Если установленный beta build OpenCode ещё не реализует command execution endpoint, UI выводит явную ошибку вместо тихой отправки команды модели как текста.

## Ограничения beta API

OpenCode V2 остаётся beta. Для rename/fork/diff/status клиент сначала использует текущий V2 HTTP contract; там, где в предыдущей сборке уже существовал другой endpoint, оставлены compatibility fallbacks. Если конкретный установленный OpenCode ещё не реализует native fork, web-клиент создаёт новую сессию в той же директории и передаёт ей ограниченный handoff-контекст.

Pin, Archive и draft — локальные browser preferences и не меняют серверную модель сессии. Queue также хранится в памяти web-клиента: это намеренно предотвращает зависимость от меняющегося beta delivery contract, а Steer отправляется через уже используемый `/api/session/:id/prompt`.

Browser notification работает, пока PWA/browser process жив и получает SSE/status updates. Полноценные push-уведомления после принудительного убийства браузера потребовали бы отдельного push service и здесь намеренно не добавлялись.

## Запуск

```bash
python3 server_ext.py
```

Основные env:

- `OPENCODE_WEB_HOST`, `OPENCODE_WEB_PORT`;
- `OPENCODE_BACKEND_URL`, `OPENCODE_BACKEND_PASSWORD`;
- `OPENCODE_SCRATCH_DIRECTORY` — root изолированных quick-session workspaces;
- `CODEX_BIN` — optional path к `codex` для OpenAI rate-limit snapshot;
- `BAILIAN_CLI_BIN` — optional path к `bl` для Qwen Token Plan usage;
- `OPENCODE_LIMITS_CACHE_SECONDS` — TTL provider snapshots, default 60.
