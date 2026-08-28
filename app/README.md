# OpenCode web client

Модульный ChatGPT-подобный web/PWA-клиент для OpenCode V2.

## Возможности

- корневые сессии сервера в sidebar; дочерние subagent-сессии скрыты;
- вверху sidebar — лимиты Qwen и OpenAI: для Qwen показываются Personal Pro caps `12 000 / 5h` и `40 000 / 7d` плюс probe/reset, для OpenAI — реальные окна/remaining/reset из локального Codex app-server `account/rateLimits/read`;
- slash-команды: ввод `/` открывает контекстный список `/api/command`, Tab/Enter вставляют выбранную команду, submit вызывает `/api/session/:id/command`; `//` экранирует slash и отправляется как обычный текст;
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
- context/token/cost widget с model context limit и Qwen quota probe из существующего title marker;
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
- `server_ext.py` — поверх proxy добавляет безопасный `/client-limits.json` и Codex app-server rate-limit bridge.

## Лимиты провайдеров

OpenAI/Codex: `server_ext.py` запускает локальный `codex app-server`, выполняет официальный RPC `account/rateLimits/read`, берёт `usedPercent`, длительность окна и `resetsAt`, после чего отдаёт браузеру только нормализованный rate-limit snapshot. Email, токены авторизации и другие данные аккаунта в браузер не передаются. Результат кэшируется на 60 секунд по умолчанию.

Qwen/Alibaba: Personal Pro имеет caps 12 000 Credits на скользящие 5 часов и 40 000 Credits на скользящие 7 дней. Публичный Token Plan API не предоставляет процент оставшейся квоты, поэтому UI не выдумывает remaining: показывает caps и результат существующего Qwen probe (`OK`/`exhausted` + reset, если он известен).

Если `codex` отсутствует в PATH, OpenAI-карточка показывает `недоступно`, не влияя на работу OpenCode. Путь можно явно задать через `CODEX_BIN`; TTL — через `OPENCODE_LIMITS_CACHE_SECONDS`.

## Slash-команды

Команды загружаются для текущей directory через `GET /api/command`. При выборе команды браузер вызывает native OpenCode `POST /api/session/:id/command` с `command` и `arguments`, то есть это именно command path OpenCode, а не prompt, замаскированный под `/команду`.

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
- `OPENCODE_LIMITS_CACHE_SECONDS` — TTL rate-limit snapshot, default 60.
