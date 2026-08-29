# custom_opencode

Переносимый комплект OpenCode V2 с отдельным web/PWA-интерфейсом, Alibaba Token Plan routing, локальным engineering RAG и ручным fallback на локальные модели.

## Что входит

- ChatGPT-подобный web/PWA-клиент с root-сессиями OpenCode;
- изолированные quick-session workspaces;
- открытие уже существующей папки/проекта на ПК из web UI;
- Build/Plan, model/provider/effort controls;
- отдельная группа бесплатных моделей в model picker;
- sidebar limits для Qwen Token Plan и OpenAI/Codex;
- native slash commands `/...` с подсказками;
- файлы, clipboard images, Markdown/code, tool/reasoning renderers;
- SSE/status updates, permissions, notifications, draft autosave;
- Git/VCS drawer, fork/duplicate/handoff;
- Alibaba Qwen Max → paid Flash orchestration;
- optional local engineering RAG через MCP;
- локальный Ollama остаётся доступен только как ручной model choice;
- systemd user-service, installer и verifier.

## Model routing

Автоматический путь теперь не зависит от локальной модели:

- primary/default: `bailian-cli/qwen3.8-max`;
- дешёвый bounded read-only worker: `bailian-cli/qwen3.6-flash` (`fast-reader`);
- session title worker: `bailian-cli/qwen3.6-flash`;
- `local-reader` сохранён только как hidden compatibility alias для старых сессий, но тоже переведён на `qwen3.6-flash`;
- `ollama/*` не используется ни одним автоматическим agent route.

`fast-reader` предназначен для поиска файлов/символов, чтения логов, механического repository exploration и точечного RAG retrieval. Он не получает edit/shell права и не должен принимать архитектурные или security-sensitive решения. Primary `qwen3.8-max` остаётся владельцем финального решения, изменений и проверки.

Локальный provider `ollama` остаётся в model catalog только для явного ручного выбора. `lazy-local-router` теперь смотрит на реальный provider ID `ollama`, но auto-start выключен по умолчанию (`OPENCODE_LOCAL_AUTO_START=0`) и ограничен health timeout. Поэтому отсутствие/падение локального inference больше не является частью критического пути автоматической работы.

## RAG integration

`config/opencode.json.template` содержит V2 MCP server `kb`. Installer ищет RAG checkout в следующем порядке:

1. `MCP_RAG_ROOT`;
2. соседний `../mcp-rag`;
3. `~/mcp-rag`.

Executable можно явно задать через `MCP_RAG_BIN`. Если working MCP executable не найден, installer рендерит `kb.disabled=true`: OpenCode запускается нормально без RAG.

Когда RAG доступен:

- transport — local stdio через `scripts/rag-mcp.sh`;
- startup/catalog timeout — 10 секунд;
- execution timeout — 60 секунд вместо длинного upstream default;
- read-only `knowledge_search/get/sources/status` разрешены `fast-reader`;
- `knowledge_ingest` для read-only worker заблокирован; для primary mutation остаётся permission-gated;
- orchestrator использует RAG только для corpus-relevant задач: datasheet/appnote, PCB/layout, DipTrace, indexed technical videos и т. п.;
- RAG error/timeout не должен блокировать основной task и не должен запускать retry loop.

Сам `mcp-rag` дополнительно выгружает FastEmbed embedding/reranker после idle grace period и имеет короткий Qdrant timeout. MCP process остаётся лёгким и подключённым, чтобы discovery не ломался; тяжёлые модели живут только когда реально нужен retrieval.

## Native OpenCode V2 config

`config/opencode.json.template` хранится в V2-формате: `providers`, `package`, `settings`, `capabilities`, `agents`, ordered `permissions`, `mcp.servers` и V2 timeout contract.

Installer рендерит только runtime placeholders (`__CONFIG_DIR__`, `__CUSTOM_OPENCODE_ROOT__`, `__RAG_DISABLED__`) и затем валидирует итоговый JSON перед записью в OpenCode config.

`AGENTS.md` устанавливается в глобальный каталог OpenCode и обнаруживается V2 автоматически.

## Web session workspaces

Quick-сессии не разделяют один filesystem workspace. Web proxy принимает `OPENCODE_SCRATCH_DIRECTORY` как root и при создании каждой quick-сессии выделяет отдельный `session-<random>` с containment checks.

В sidebar такие сессии логически объединяются в `Быстрые`, child/subagent sessions скрываются. При удалении очищается только безопасно распознанный дочерний scratch-каталог; root и любые пути вне scratch удалить этим механизмом нельзя.

## Открытие существующего проекта

Кнопка `Проекты` в web UI показывает уже известные OpenCode проекты и пункт `Папки на ПК`.

Folder browser:

- не содержит текстового поля пути;
- навигация только кнопками по директориям;
- показывает только директории, не содержимое файлов;
- скрывает dot-directories;
- разрешает только пути внутри `OPENCODE_PROJECT_ROOTS`;
- canonicalizes symlinks и не показывает symlink, уходящий за разрешённый root;
- после `Открыть эту папку` создаёт новую OpenCode session с `location.directory` выбранной папки.

По умолчанию `OPENCODE_PROJECT_ROOTS=~`. Для более узкой поверхности лучше перечислить только каталоги с проектами через `;`, например `~/code;~/projects`.

## Model picker

Поле поиска моделей удалено из UI (оставлен hidden compatibility input, чтобы не ломать основной client code). На телефоне открытие model picker больше не должно автоматически поднимать клавиатуру.

Сверху появляется группа `Бесплатные модели`. Сначала она определяется по V2 model cost metadata: все input/output/cache costs должны быть нулевыми. Если upstream build не отдаёт cost metadata, используется ограниченный fallback по free model ID. Поэтому временная ротация бесплатного каталога OpenCode не требует постоянного hardcode полного списка.

## Alibaba Cloud Model Studio

Provider `bailian-cli` настроен под Token Plan Personal Pro и сохраняет этот ID ради совместимости с существующими сессиями/favorites.

Personal catalog:

- `qwen3.8-max`;
- `qwen3.8-flash`;
- `qwen3.7-max`;
- `qwen3.7-plus`;
- `qwen3.6-flash`;
- `glm-5.2`;
- `deepseek-v4-pro`;
- `deepseek-v4-pro-0813`;
- `deepseek-v4-flash-0731`.

`qwen3.8-max-preview` остаётся compatibility catalog ID и через `modelID` направляется в актуальный `qwen3.8-max`.

API key хранится только в приватном `.env`. Image/video/speech generation не смешивается с обычным LLM model picker и должна подключаться через соответствующие Skills/extensions.

## Sidebar provider limits

- Qwen: `bl usage token-plan --output json` → 5h/7d usage, remaining %, approximate remaining credits и reset;
- OpenAI/Codex: local `codex app-server` RPC `account/rateLimits/read` → primary/secondary windows и reset;
- browser получает только нормализованный snapshot без OAuth/API credentials;
- cache default 60 секунд.

## Slash commands

В composer `/` открывает context-aware список из `GET /api/command`. Показываются command name, description и upstream hints (`$1`, `$ARGUMENTS`, ...). Выполнение идёт через native `POST /api/session/:id/command`, а не как обычный prompt. `//text` экранирует slash-команду и отправляет `/text` как сообщение.

## Секреты и сетевые адреса

Пароли, ключи и локальные/LAN/tailnet адреса находятся только в `.env`; файл исключён из Git. `scripts/verify.sh` проверяет syntax, common secrets, literal IPv4, personal absolute paths, provider allowlist и ключевые architecture invariants.

Web proxy использует Basic Auth. Для недоверенной сети его следует держать только за TLS/Tailscale/reverse proxy, а не публиковать plaintext HTTP напрямую.

## Переносимые пути

Основные env:

- `OPENCODE_CONFIG_DIR` — global OpenCode config;
- `OPENCODE_AUTH_FILE` — OpenCode auth storage;
- `OPENCODE_SERVICE_FILE` — V2 backend discovery;
- `OPENCODE_SCRATCH_DIRECTORY` — quick-session root;
- `OPENCODE_PROJECT_ROOTS` — разрешённые roots web folder browser;
- `MCP_RAG_ROOT`, `MCP_RAG_BIN` — local RAG checkout/executable;
- `BAILIAN_CONFIG_PATH` — Bailian CLI config;
- `OPENCODE_LOCAL_AUTO_START` — optional manual-local lazy start.

## Установка

Требуются OpenCode V2, Python 3, Node.js и systemd user services.

```bash
cp .env.example .env
# заполнить .env
./scripts/verify.sh
./scripts/install.sh
```

После установки запускайте OpenCode через `custom-opencode`.

Если `mcp-rag` лежит рядом с `custom_opencode` и имеет `.venv/bin/knowledge-mcp`, installer подключит его автоматически. Иначе задайте `MCP_RAG_ROOT`/`MCP_RAG_BIN` и повторно запустите install/update.

## Обновление

```bash
custom-opencode-update
```

Команда делает `git pull --ff-only`, повторно рендерит config, проверяет наличие RAG и перезапускает V2/web services.

## Структура

- `app/` — web client, same-origin proxy, rate-limit bridge и safe project browser;
- `config/` — V2 config, agents, orchestrator prompt, plugins;
- `systemd/` — user service;
- `scripts/` — install/update/verify и RAG launcher.

## Что всё ещё требует runtime smoke на конкретной машине

OpenCode V2 остаётся beta. После upstream upgrade стоит прогонять `./scripts/verify.sh` и короткий end-to-end smoke: Max primary → Flash subagent, RAG search с запущенным/остановленным Qdrant, model picker на телефоне и открытие реальной project directory через web UI.
