# Архитектура и возможности

## Что такое custom_opencode

`custom_opencode` не является форком OpenCode. Это host-side комплект вокруг OpenCode V2, который добавляет собственный web/PWA client, переносимую конфигурацию, model routing, диагностику, безопасный browser локальных проектов и опциональную связь с `mcp-rag`.

Главная идея: OpenCode остаётся execution/model backend, а `custom_opencode` управляет UX и локальной интеграцией.

## Компоненты

### OpenCode V2 backend

Отвечает за:

- sessions;
- agents/subagents;
- model/provider execution;
- permissions;
- native commands;
- MCP supervision;
- Git/VCS/session APIs.

`custom_opencode` не пытается заново реализовать model runtime.

### Web/PWA client

Каталог `app/` содержит отдельный UI и same-origin authenticated proxy.

Основные возможности:

- root sessions в sidebar;
- child/subagent sessions скрыты из обычного списка;
- isolated quick-session workspaces;
- параллельные running states;
- automatic delivery: send / cancel / queue без ручного Steer/Queue toggle;
- одна контекстная action button в composer;
- только `Build/Plan` как пользовательские execution modes;
- orchestration выбирается специальной моделью `Qwen 3.8 Max · Оркестрированная` через model picker;
- favorites-first model sorting и collapsible providers;
- compact permission cards с raw payload под раскрытием;
- rename/delete/fork/duplicate/project handoff;
- deep links;
- Markdown/code rendering;
- tool/reasoning blocks;
- file/image attachments;
- notifications и draft autosave;
- Git/VCS drawer;
- context/cost usage;
- provider usage limits;
- slash palette;
- project folder browser;
- Doctor и `/rag-start`.

### Server layers

Web server расширяется слоями:

```text
server.py
  └── server_ext.py
        └── server_plus.py
              └── server_rag.py
```

`server.py`:

- Basic Auth;
- same-origin proxy к OpenCode backend;
- quick-session isolation;
- safe scratch cleanup.

`server_ext.py`:

- provider-limit bridges для Codex и Bailian.

`server_plus.py`:

- browser разрешённых host directories через `OPENCODE_PROJECT_ROOTS`;
- symlink containment;
- Doctor endpoints и smoke infrastructure.

`server_rag.py`:

- `/rag-start` lifecycle;
- current OpenCode V2 MCP workspace routing;
- dynamic `kb` connect;
- persisted RAG enablement после успешной проверки.

Systemd запускает именно `app/server_rag.py`.

## Quick sessions

Quick-session создаётся не в одном общем directory, а в отдельном:

```text
<OPENCODE_SCRATCH_DIRECTORY>/session-<random>/
```

Это уменьшает риск пересечения временных файлов между независимыми сессиями.

При удалении session proxy удаляет directory только если он прошёл containment check внутри scratch root. Сам scratch root и любые внешние пути не удаляются этим механизмом.

## Открытие локальных проектов

`Проекты → Папки на ПК` работает через server-side directory browser.

Browser:

- принимает только путь внутри разрешённых roots;
- canonicalizes paths;
- блокирует symlink escape;
- скрывает dot-directories;
- отдаёт только директории, а не содержимое файлов;
- ограничивает размер listing;
- не содержит текстового поля пути.

После выбора создаётся обычная OpenCode session с `location.directory` выбранного проекта.

## Build / Plan и model picker

Видимый search input удалён, чтобы model picker на мобильном не вызывал клавиатуру.

Catalog UI сохраняет favorites и предоставляет collapsible provider sections. Внутри группы сначала идут favorite entries, затем текущая модель, затем alphabetical sort.

Группа `Бесплатные модели` определяется в первую очередь по model cost metadata. Если upstream build не отдаёт cost, используется небольшой fallback по ID.

Пользователь выбирает только execution mode:

```text
Build | Plan
```

и отдельно модель.

Обычный model entry означает direct execution выбранной моделью. Специальный UI entry:

```text
Qwen 3.8 Max · Оркестрированная
```

включает orchestration поверх того же `bailian-cli/qwen3.8-max`.

Внутренняя матрица OpenCode agents:

```text
обычная модель + Build         → build-direct
обычная модель + Plan          → plan-direct
Оркестрированная + Build       → build
Оркестрированная + Plan        → plan
```

Эти agent IDs являются implementation detail и скрыты за двумя пользовательскими mode controls.

## Composer state machine

В OpenCode API сохраняются delivery semantics, но пользовательский toggle убран.

```text
нет active run                  → send
active run + empty composer     → cancel current run
active run + text/attachment    → queue
```

Скрытый compatibility layer по-прежнему использует native delivery API, поэтому backend contract не подменяется frontend-эмуляцией.

## Permissions

Permission request может содержать большой command/resource payload. Web UI не показывает этот payload целиком в основной строке. На поверхности остаётся короткий action summary максимум в две строки; полный raw detail находится в collapsible block с bounded scroll area.

Кнопки `Отклонить / Разрешить / Всегда` продолжают работать через native OpenCode permission reply API.

## Slash commands

Обычные native OpenCode команды загружаются через `/api/command` и исполняются через session command API.

Локальные control-команды вроде `/doctor` и `/rag-start` перехватываются web layer и не отправляются модели как prompt.

## Provider limits

Sidebar может показывать:

- Alibaba/Qwen Token Plan usage через Bailian CLI;
- OpenAI/Codex rate-limit windows через локальный Codex app-server RPC.

Credentials остаются на host. Browser получает только нормализованный snapshot.

## RAG

`kb` — optional local MCP server. OpenCode контролирует lifecycle stdio-процесса `knowledge-mcp`.

`custom_opencode` не держит отдельный RAG daemon. Из инфраструктурных процессов RAG использует Qdrant.

Automatic retrieval разрешён только orchestrated model profile. Обычные model profiles явно запрещают `kb_knowledge_*` tools.

Подробнее: [rag.md](rag.md).

## Installer

Installer не просто копирует конфиги. Он является deployment gate:

```text
verify source/contracts
       ↓
render/install config
       ↓
restart services
       ↓
real host self-test
```

Это важно из-за beta-совместимости OpenCode V2: статически валидный config ещё не доказывает, что backend/API/MCP реально поднялись на конкретной машине.

## Security boundaries

Система использует несколько независимых boundaries:

- `.env` не tracked;
- web Basic Auth;
- recommended loopback bind;
- project root allowlist;
- scratch containment;
- ordinary model profiles deny automatic subagent/RAG;
- orchestrated read worker permission deny-first;
- RAG ingest permission-gated;
- MCP execution timeout;
- RAG private-network ingest blocked по умолчанию;
- Qdrant loopback-only в `mcp-rag` Compose;
- no automatic local-model dependency.

## Что не является гарантией

- `kb: connected` сам по себе не доказывает, что MCP tools реально доступны — поэтому Doctor делает отдельный protocol probe.
- model в catalog не доказывает успешный inference — это проверяет только ручной paid smoke.
- GitHub CI не доказывает состояние локального Qdrant/corpus/auth — поэтому install self-test запускается на host.
