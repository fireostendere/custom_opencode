# OpenCode web client

Модульный ChatGPT-подобный web/PWA-клиент для OpenCode V2.

## Возможности

- корневые сессии сервера в sidebar; дочерние subagent-сессии скрыты;
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
- Token Plan Personal Pro caps показываются отдельно от фактического расхода, который probe API не возвращает;
- browser/PWA notifications о завершении фоновой сессии и permission request;
- текст draft автоматически сохраняется по session ID в localStorage;
- файлы добавляются кнопкой `+`, изображения можно вставлять из clipboard;
- permissions можно принять/отклонить из браузера;
- SSE обновляет reasoning/tools без перезагрузки; session status дополнительно сверяется polling-ом;
- pull-down refresh сохранён для мобильного режима.

## Структура

- `index.html` — только application shell;
- `styles.css` — UI и responsive layout;
- `api.js` — OpenCode HTTP adapter и compatibility fallbacks;
- `markdown.js` — безопасный Markdown/code renderer;
- `app.js` — session store, event stream и UI orchestration;
- `sw.js` — PWA runtime cache и notification surface;
- `server.py` — same-origin authenticated proxy и isolated quick workspaces.

## Ограничения beta API

OpenCode V2 остаётся beta. Для rename/fork/diff/status клиент сначала использует текущий V2 HTTP contract; там, где в предыдущей сборке уже существовал другой endpoint, оставлены compatibility fallbacks. Если конкретный установленный OpenCode ещё не реализует native fork, web-клиент создаёт новую сессию в той же директории и передаёт ей ограниченный handoff-контекст.

Pin, Archive и draft — локальные browser preferences и не меняют серверную модель сессии. Queue также хранится в памяти web-клиента: это намеренно предотвращает зависимость от меняющегося beta delivery contract, а Steer отправляется через уже используемый `/api/session/:id/prompt`.

Browser notification работает, пока PWA/browser process жив и получает SSE/status updates. Полноценные push-уведомления после принудительного убийства браузера потребовали бы отдельного push service и здесь намеренно не добавлялись.

## Запуск

```bash
python3 server.py
```

Основные env:

- `OPENCODE_WEB_HOST`, `OPENCODE_WEB_PORT`;
- `OPENCODE_BACKEND_URL`, `OPENCODE_BACKEND_PASSWORD`;
- `OPENCODE_SCRATCH_DIRECTORY` — root изолированных quick-session workspaces.
