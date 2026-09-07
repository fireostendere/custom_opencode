# Установка, миграция и обновление

## Требования

Минимально нужны:

- Linux/WSL-среда с `systemd --user`;
- Python 3;
- Node.js + npm — installer сам bootstrap-ит закреплённую проверенную сборку OpenCode V2 (`opencode2`) и использует Node.js для JS syntax/web smoke;
- Git;
- приватный `.env` с web password и нужными provider credentials.

Для Alibaba/Qwen нужен Token Plan/API credential. Для sidebar usage желательно наличие Bailian CLI `bl`.

Для включённого Ponytail нужен сетевой доступ к его GitHub upstream при первой установке или обновлении managed checkout.

RAG необязателен. Для него дополнительно нужны Docker + Compose, Python >= 3.10 и checkout `mcp-rag` с рабочим `.venv/bin/knowledge-mcp`.

## Рекомендуемое расположение

Удобнее держать репозитории рядом:

```text
~/ai/
├── custom_opencode/
└── mcp-rag/
```

При таком расположении installer автоматически обнаруживает `../mcp-rag`, если в нём уже существует `.venv/bin/knowledge-mcp`.

## Новая установка custom_opencode

```bash
git clone <custom_opencode repo URL>
cd custom_opencode
cp .env.example .env
```

Отредактируйте `.env`. Обязательно задайте как минимум:

```text
OPENCODE_SERVER_PASSWORD=<strong local password>
OPENCODE_AUTH_ALLOW_BASIC=0
OPENCODE_AUTH_COOKIE_SECURE=auto
TOKEN_PLAN_API_KEY=<Alibaba Token Plan key>
CUSTOM_OPENCODE_INSTALL_SELFTEST=1
OPENCODE_LOCAL_AUTO_START=0
PONYTAIL_ENABLED=1
PONYTAIL_DEFAULT_MODE=full
```

`OPENCODE_AUTH_ALLOW_BASIC=0` оставляет обычный browser UX на custom login page без native Chrome Basic Auth prompt. Если UI публикуется через HTTPS reverse proxy, `OPENCODE_AUTH_COOKIE_SECURE=auto` обычно достаточно при корректном `X-Forwarded-Proto`/`Forwarded`.

Если RAG находится не рядом с репозиторием, задайте абсолютные пути:

```text
MCP_RAG_ROOT=/absolute/path/to/mcp-rag
MCP_RAG_BIN=/absolute/path/to/mcp-rag/.venv/bin/knowledge-mcp
```

Далее:

```bash
./scripts/verify.sh
./scripts/install.sh
```

Installer:

1. загружает `.env`;
2. если версия `opencode2` отличается от `OPENCODE_CLI_PACKAGE`, устанавливает закреплённую сборку в `~/.local`;
3. обнаруживает RAG;
4. валидирует и provision-ит pinned Ponytail checkout, если он включён;
5. при включённом self-test выполняет pre-install verifier до записи конфигов;
6. создаёт/обновляет user systemd unit;
7. рендерит актуальный OpenCode V2 config;
8. делает backup существующего `opencode.json`;
9. устанавливает `AGENTS.md`, prompts и plugins;
10. аккуратно дополняет auth storage только реально заданными credential fields;
11. создаёт `~/.local/bin/custom-opencode`, `custom-opencode-update` и контроллер `custom-opencode-webserver` для TUI wizard;
12. перезапускает web/OpenCode V2 services;
13. выполняет post-install zero-LLM-token self-test.

Успешная установка заканчивается `Self-test PASS`.

## Ponytail checkout

Installer управляет отдельным checkout `DietrichGebert/ponytail` на reviewed commit `2ed6c52c9d7e5e56942508591085fd45dea277d3`. Путь по умолчанию — `$XDG_DATA_HOME/opencode/ponytail` или `~/.local/share/opencode/ponytail`. В конфигурацию OpenCode попадает только абсолютный путь к `.opencode/plugins/ponytail.mjs`; upstream `skills/`, `commands/` и `hooks/` не копируются в `~/.config/opencode`.

Provisioning fail-closed проверяет origin, ветку `main`, чистоту checkout, наличие обязательных файлов, принадлежность pin к `origin/main` и fast-forward-only обновление. Неиспользуемые локальные коммиты и изменения не перезаписываются.

Состояние режима хранится в `~/.config/opencode/.ponytail-active` либо в соответствующем `$XDG_CONFIG_HOME/opencode`. Первый install записывает `PONYTAIL_DEFAULT_MODE` только если state-файла ещё нет; последующие install/update пользовательский режим не меняют. `/ponytail ...` меняет его явно.

Чтобы отключить plugin без удаления managed checkout:

```text
PONYTAIL_ENABLED=0
```

Для отдельно одобренного upstream/pin доступны `PONYTAIL_UPSTREAM_URL`, `PONYTAIL_PIN_COMMIT` (только полный 40-символьный SHA) и `PONYTAIL_CHECKOUT_DIR`. Непросмотренный pin подменять не следует.

## Первый web-вход

Откройте URL `custom_opencode` в браузере. Для удалённого клиента должна появиться собственная страница `OpenCode → Вход`, а не системный Chrome login/password dialog.

Используйте:

```text
username = OPENCODE_SERVER_USERNAME   # default opencode
password = OPENCODE_SERVER_PASSWORD
```

`Запомнить вход` создаёт только долгоживущую подписанную HttpOnly cookie; приложение не сохраняет пароль в localStorage. По умолчанию remembered session действует 30 дней.

При локальном loopback-доступе и `OPENCODE_WEB_ALLOW_LOCAL=1` login может быть пропущен — это штатный local bypass.

После входа UI settings находятся в sidebar: `Аккаунт → Настройки`. Тема и accent сохраняются только в текущем browser profile.

## Автоматическая verification pipeline

Repository-defined `lint`/`test`/`pytest`/`cargo`/`go` команды считаются исполняемым кодом проекта. Поэтому даже при `OPENCODE_VERIFY_PIPELINE=auto` сервер не запускает их, пока для доверенного checkout явно не задано `OPENCODE_VERIFY_TRUST_REPO=1`. Для чужих или только что клонированных репозиториев оставляйте значение `0`.

## Что проверяет install self-test

До изменений на диске запускается полный `scripts/verify.sh`: Python/JS/bash syntax, web smoke, router/config invariants, project-browser boundaries, RAG mocked lifecycle, secret/path guards.

После рестарта проверяется реальная машина:

- `opencode-web-client.service` находится в `active`;
- production web composition импортируется с текущим runtime config;
- OpenCode backend отвечает;
- authenticated web endpoint отвечает HTTP 200;
- если RAG обнаружен — выполняется эквивалент `/rag-start quick`: Qdrant/corpus + `kb` MCP + required tools.

Self-test не делает Qwen/OpenAI inference и не расходует LLM-токены.

Аварийно можно отключить его:

```text
CUSTOM_OPENCODE_INSTALL_SELFTEST=0
```

Это recovery-механизм, а не рекомендуемый постоянный режим.

## Установка RAG с нуля

Сначала установите `mcp-rag`, затем повторите install/update `custom_opencode`.

Типовой порядок:

```bash
cd mcp-rag
uv venv .venv
uv pip install -e ".[dev,youtube]" --python .venv/bin/python
docker compose up -d
```

Добавьте/настройте sources, затем выполните осознанный initial ingest:

```bash
.venv/bin/knowledge ingest-all
```

После появления corpus/index:

```bash
.venv/bin/python -m knowledge_base.runtime --json --no-start
```

После этого укажите `MCP_RAG_ROOT`/`MCP_RAG_BIN` в `custom_opencode/.env` и снова запустите:

```bash
./scripts/install.sh
```

Подробности по corpus и ingestion находятся в документации `mcp-rag`.

## Миграция существующей установки

Не заменяйте старый `.env` файлом `.env.example`.

Перед миграцией сохраните:

- текущий `.env`;
- `~/.config/opencode/opencode.json` и связанные prompts/plugins;
- `~/.local/share/opencode/auth.json`;
- текущий systemd unit;
- commit SHA обоих репозиториев;
- для RAG — путь к data directory/SQLite registry и Qdrant volume.

Далее обновите сначала `mcp-rag`, потом `custom_opencode`:

```bash
cd /path/to/mcp-rag
git pull --ff-only

cd /path/to/custom_opencode
git pull --ff-only
```

Сверьте существующий `.env` с новым `.env.example`: добавьте отсутствующие keys, но сохраните реальные credentials и рабочие пути. Особое внимание:

```text
OPENCODE_AUTH_SESSION_SECONDS
OPENCODE_AUTH_REMEMBER_SECONDS
OPENCODE_AUTH_COOKIE_SECURE
OPENCODE_AUTH_ALLOW_BASIC=0
MCP_RAG_ROOT
MCP_RAG_BIN
OPENCODE_PROJECT_ROOTS
TOKEN_PLAN_API_KEY
OPENCODE_LOCAL_AUTO_START=0
CUSTOM_OPENCODE_INSTALL_SELFTEST=1
```

После этого:

```bash
./scripts/verify.sh
./scripts/install.sh
```

Не используйте `git reset --hard`, `docker compose down -v` или RAG rebuild как обычный шаг миграции.

Существующие browser drafts/theme settings остаются browser-local. Старая Basic-auth credential cache браузера больше не является источником состояния новой web session.

## Обновление

После первой установки доступно:

```bash
custom-opencode-update
```

Команда выполняет `git fetch --prune origin main`, затем `git merge --ff-only FETCH_HEAD` и повторно запускает installer. Поэтому verifier и post-install self-test выполняются и после обычного обновления. Если `.env` уже существует и в нём нет строки, начинающейся точно с `OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT=`, updater добавляет `OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT=1`; существующее значение не меняется. Строки с `export` или ведущими пробелами ключом не считаются.

`custom-opencode-update` обновляет только `custom_opencode`. Если изменился `mcp-rag`, сначала выполните `git pull --ff-only` внутри RAG checkout.

## Проверка после установки

```bash
systemctl --user status opencode-web-client.service --no-pager
custom-opencode --version || true
```

После установки в web UI дополнительно проверьте:

- login/logout и `Запомнить вход` с удалённого origin;
- возврат после re-auth в текущий `#/session/...`;
- light/dark/system theme;
- mobile drawer через tap вне панели, swipe и Back;
- `prefers-reduced-motion` при необходимости accessibility-проверки.

Если используется RAG, выполните сначала:

```text
/rag-start quick
```

а затем при необходимости полный бесплатный retrieval check:

```text
/rag-start
```
