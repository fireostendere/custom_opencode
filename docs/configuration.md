# Конфигурация `.env`

`.env` — главный host-specific файл `custom_opencode`. Он не должен попадать в Git. `scripts/install.sh` загружает его перед рендером runtime config и запуском self-test.

Начальная точка:

```bash
cp .env.example .env
chmod 600 .env
```

Не копируйте `.env.example` поверх уже настроенного `.env` при обновлении. Новые keys добавляйте merge-ом.

## Web UI

```text
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=<required>
OPENCODE_WEB_HOST=localhost
OPENCODE_WEB_PORT=4098
OPENCODE_WEB_ALLOW_LOCAL=1
OPENCODE_SCRATCH_DIRECTORY=
OPENCODE_PROJECT_ROOTS=~
```

`OPENCODE_SERVER_PASSWORD` обязателен. Web proxy использует Basic Auth.

`OPENCODE_WEB_HOST=localhost` — безопасный default. Если UI публикуется в LAN/tailnet, используйте TLS/Tailscale/reverse proxy и не выставляйте plaintext HTTP в недоверенную сеть.

`OPENCODE_SCRATCH_DIRECTORY` задаёт root для изолированных quick-session directories. Пустое значение приводит к default `~/opencode-scratch`.

`OPENCODE_PROJECT_ROOTS` — список разрешённых roots для `Проекты → Папки на ПК`, разделитель `;`:

```text
OPENCODE_PROJECT_ROOTS=~/code;~/projects
```

Чем уже список, тем меньше filesystem surface доступна web folder browser.

## Публичные/удалённые ссылки

```text
OPENCODE_LOCAL_URL=http://localhost:4098
OPENCODE_LAN_URL=https://your-lan-hostname
OPENCODE_TAILSCALE_URL=https://your-tailnet-hostname
```

Это host-specific значения. Не хардкодьте реальные LAN/tailnet адреса в tracked config.

## OpenCode backend discovery

```text
OPENCODE_BACKEND_URL=
OPENCODE_BACKEND_USERNAME=opencode
OPENCODE_BACKEND_PASSWORD=
OPENCODE_SERVICE_FILE=
OPENCODE_LEGACY_AUTH_FILE=
```

Нормальный режим — service discovery через state file OpenCode V2. `OPENCODE_BACKEND_URL` и password нужны только когда backend явно закреплён вручную.

Не заполняйте explicit backend values без необходимости: это делает установку менее переносимой.

## Provider-limit bridges

```text
CODEX_BIN=
BAILIAN_CLI_BIN=
OPENCODE_LIMITS_CACHE_SECONDS=60
```

Если `codex` и `bl` доступны через `PATH`, явные пути не нужны.

- Codex bridge читает rate limits через локальный `codex app-server` RPC.
- Bailian bridge читает Token Plan usage через `bl usage token-plan --output json`.
- Browser получает нормализованные данные, а не OAuth/API credentials.

## RAG

```text
MCP_RAG_ROOT=
MCP_RAG_BIN=
```

Installer ищет RAG в порядке:

1. `MCP_RAG_ROOT`;
2. соседний `../mcp-rag`;
3. `~/mcp-rag`.

Для предсказуемой production-like установки лучше задать абсолютные пути:

```text
MCP_RAG_ROOT=/absolute/path/to/mcp-rag
MCP_RAG_BIN=/absolute/path/to/mcp-rag/.venv/bin/knowledge-mcp
```

Если executable отсутствует, `kb` автоматически рендерится disabled и OpenCode продолжает работать без RAG.

## Alibaba / Qwen Token Plan

```text
TOKEN_PLAN_API_KEY=<required for Alibaba models>
TOKEN_PLAN_ANTHROPIC_BASE_URL=https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1
TOKEN_PLAN_OPENAI_BASE_URL=https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
TOKEN_PLAN_PROBE_MODEL=qwen3.8-max
BAILIAN_CONFIG_PATH=
```

Основной OpenCode provider `bailian-cli` использует Anthropic-compatible endpoint и `TOKEN_PLAN_API_KEY`.

Не печатайте key в диагностических логах и не переносите его в tracked JSON.

## Локальный Ollama

```text
OLLAMA_BASE_URL=http://localhost:11434/v1
OPENCODE_LOCAL_AUTO_START=0
OPENCODE_LOCAL_PROVIDER=ollama
OPENCODE_LOCAL_ROUTER_URL=
OPENCODE_LOCAL_ROUTER_START=
OPENCODE_LOCAL_ROUTER_LOG=
```

Рекомендуемый default — `OPENCODE_LOCAL_AUTO_START=0`.

Локальные модели присутствуют в catalog для ручного выбора, но автоматические agents не должны зависеть от Ollama. Старые router variables можно хранить для ручного/экспериментального режима.

## Installer

```text
OPENCODE_CONFIG_DIR=
OPENCODE_AUTH_FILE=
OPENCODE_CONFIG_BACKUP_DIR=
OPENCODE_CONFIG_BACKUP_KEEP=20
INSTALL_OPENCODE_CONFIG=1
CUSTOM_OPENCODE_INSTALL_SELFTEST=1
```

Если `OPENCODE_CONFIG_DIR` пуст, используется `~/.config/opencode`.

Если `OPENCODE_AUTH_FILE` пуст, используется `~/.local/share/opencode/auth.json`.

`CUSTOM_OPENCODE_INSTALL_SELFTEST=1` должен оставаться включённым. `0` предназначен только для аварийного recovery, когда сломанный runtime не позволяет installer завершиться.

## Опциональные auth backup fields

```text
OPENCODE_OPENAI_ACCESS=CHANGE_ME
OPENCODE_OPENAI_REFRESH=CHANGE_ME
OPENCODE_OPENAI_EXPIRES=0
OPENCODE_OPENAI_ACCOUNT_ID=CHANGE_ME
OPENCODE_ZEN_KEY=CHANGE_ME
OPENCODE_GO_KEY=CHANGE_ME
```

Installer записывает в auth storage только реально заданные значения, отличные от `CHANGE_ME`.

Если рабочие credentials уже находятся в `auth.json`, не нужно копировать их обратно в `.env` только ради заполнения этих полей.

## Рекомендованный минимальный `.env`

Пример структуры без реальных секретов:

```text
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=<set>
OPENCODE_WEB_HOST=localhost
OPENCODE_WEB_PORT=4098
OPENCODE_WEB_ALLOW_LOCAL=1
OPENCODE_PROJECT_ROOTS=~/code;~/projects

TOKEN_PLAN_API_KEY=<set>
TOKEN_PLAN_ANTHROPIC_BASE_URL=https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1
TOKEN_PLAN_OPENAI_BASE_URL=https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
TOKEN_PLAN_PROBE_MODEL=qwen3.8-max

MCP_RAG_ROOT=/absolute/path/to/mcp-rag
MCP_RAG_BIN=/absolute/path/to/mcp-rag/.venv/bin/knowledge-mcp

OPENCODE_LOCAL_AUTO_START=0
OPENCODE_LOCAL_PROVIDER=ollama
CUSTOM_OPENCODE_INSTALL_SELFTEST=1
INSTALL_OPENCODE_CONFIG=1
```

## Проверка `.env`

Перед install/update полезно проверить:

```bash
set -a
source .env
set +a
```

Затем:

```bash
./scripts/verify.sh
```

Verifier специально ищет случайно закоммиченные секреты, personal absolute paths и сетевые literals в tracked source. `.env` из проверки исключён.
