# Установка, миграция и обновление

## Требования

Минимально нужны:

- Linux/WSL-среда с `systemd --user`;
- OpenCode V2 (`opencode2` либо совместимый `opencode`);
- Python 3;
- Node.js — нужен `scripts/verify.sh` для JS syntax/web smoke;
- Git;
- приватный `.env` с web password и нужными provider credentials.

Для Alibaba/Qwen нужен Token Plan/API credential. Для sidebar usage желательно наличие Bailian CLI `bl`.

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
TOKEN_PLAN_API_KEY=<Alibaba Token Plan key>
CUSTOM_OPENCODE_INSTALL_SELFTEST=1
OPENCODE_LOCAL_AUTO_START=0
```

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
2. обнаруживает RAG;
3. при включённом self-test выполняет pre-install verifier до записи конфигов;
4. создаёт/обновляет user systemd unit;
5. рендерит актуальный OpenCode V2 config;
6. делает backup существующего `opencode.json`;
7. устанавливает `AGENTS.md`, prompts и plugins;
8. аккуратно дополняет auth storage только реально заданными credential fields;
9. создаёт `~/.local/bin/custom-opencode` и `custom-opencode-update`;
10. перезапускает web/OpenCode services;
11. выполняет post-install zero-LLM-token self-test.

Успешная установка заканчивается `Self-test PASS`.

## Что проверяет install self-test

До изменений на диске запускается полный `scripts/verify.sh`: Python/JS/bash syntax, web smoke, router/config invariants, project-browser boundaries, RAG mocked lifecycle, secret/path guards.

После рестарта проверяется реальная машина:

- `opencode-web-client.service` находится в `active`;
- `server_rag.py` импортируется с текущим runtime config;
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

## Обновление

После первой установки доступно:

```bash
custom-opencode-update
```

Команда делает `git pull --ff-only`, затем повторно запускает installer. Поэтому verifier и post-install self-test выполняются и после обычного обновления.

`custom-opencode-update` обновляет только `custom_opencode`. Если изменился `mcp-rag`, сначала выполните `git pull --ff-only` внутри RAG checkout.

## Проверка после установки

```bash
systemctl --user status opencode-web-client.service --no-pager
custom-opencode --version || true
```

В web UI откройте `Диагностика` или `/doctor`. Если используется RAG, выполните сначала:

```text
/rag-start quick
```

а затем при необходимости полный бесплатный retrieval check:

```text
/rag-start
```

Платные model/router smoke tests в Doctor запускаются только вручную.
