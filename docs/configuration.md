# Конфигурация `.env`

`.env` — главный host-specific файл `custom_opencode`. Он не должен попадать в Git. `scripts/install.sh` загружает его перед рендером runtime config и запуском self-test.

Начальная точка:

```bash
cp .env.example .env
chmod 600 .env
```

Не копируйте `.env.example` поверх уже настроенного `.env` при обновлении. Новые keys добавляйте merge-ом.

## Web UI и авторизация

```text
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=<required>
OPENCODE_AUTH_SESSION_SECONDS=86400
OPENCODE_AUTH_REMEMBER_SECONDS=2592000
OPENCODE_AUTH_COOKIE_SECURE=auto
OPENCODE_AUTH_ALLOW_BASIC=0
OPENCODE_WEB_HOST=localhost
OPENCODE_WEB_PORT=4098
OPENCODE_WEB_ALLOW_LOCAL=0
OPENCODE_SCRATCH_DIRECTORY=
OPENCODE_PROJECT_ROOTS=~
```

`OPENCODE_SERVER_PASSWORD` обязателен. Обычный web UI использует собственную login page и подписанную `HttpOnly` cookie.

- `OPENCODE_AUTH_SESSION_SECONDS` — TTL обычной session cookie.
- `OPENCODE_AUTH_REMEMBER_SECONDS` — TTL при `Запомнить вход`.
- `OPENCODE_AUTH_COOKIE_SECURE=auto` — включает `Secure` при HTTPS.
- `OPENCODE_AUTH_ALLOW_BASIC=0` — рекомендуемый default.
- `OPENCODE_WEB_ALLOW_LOCAL=0` — рекомендуемый безопасный default.

`OPENCODE_PROJECT_ROOTS` — список разрешённых roots для browser project picker, разделитель `;`.

## Role-based model routing

Canonical role refs:

```text
OPENCODE_PLANNER_MODEL=bailian-cli/qwen3.8-max
OPENCODE_BUILDER_MODEL=bailian-cli/qwen3.7-plus
OPENCODE_READER_MODEL=bailian-cli/qwen3.8-flash
OPENCODE_REVIEW_MODEL=bailian-cli/deepseek-v4-pro-0813
OPENCODE_LONG_HORIZON_MODEL=bailian-cli/glm-5.2
OPENCODE_ORCHESTRATED_MODEL=bailian-cli/qwen3.8-orchestrated
```

Эти роли provider-locked на Alibaba Cloud/Bailian. Qwen, DeepSeek и GLM из orchestration stack не должны автоматически уходить на другой gateway/provider.

`direct` сохраняет ровно выбранную пользователем модель. Managed profiles (`fast`, `build`, `architect`, `critical`, `research`, `long-horizon`) используют только собственные role refs.

Host load, GPU state, запущенные игры и доступность другого inference endpoint не участвуют в выборе model route.

## Reasoning effort

Canonical levels:

```text
auto
minimal
low
medium
high
max
```

`max` — semantic runtime intent: использовать максимальный reasoning effort, который реально поддерживается данной model/provider pair. Runtime/provider adapter переводит его в фактический provider-specific уровень.

Default policy:

```text
reader     low
builder    medium
planner    high
reviewer   high
```

Escalation normal coding:

```text
Plus medium
→ Plus high
→ Max high
→ Max max только для exceptional/critical reasoning
```

## Alibaba / Qwen Token Plan

```text
TOKEN_PLAN_API_KEY=<required for Alibaba models>
TOKEN_PLAN_ANTHROPIC_BASE_URL=https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1
TOKEN_PLAN_OPENAI_BASE_URL=https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
TOKEN_PLAN_PROBE_MODEL=qwen3.8-max
BAILIAN_CONFIG_PATH=
QWEN_QUOTA_PROBE_ENABLED=0
```

Основной OpenCode provider `bailian-cli` использует Anthropic-compatible endpoint и `TOKEN_PLAN_API_KEY`.

Не печатайте key в диагностических логах и не переносите его в tracked JSON.

`QWEN_QUOTA_PROBE_ENABLED=0` оставляет install/restart и обычный runtime без автоматического paid inference probe.

## Manual provider endpoints

`OLLAMA_BASE_URL` существует только как endpoint обычного manually selectable provider из OpenCode catalog. Role router его не читает, не проверяет его доступность и не выбирает его автоматически.

```text
OLLAMA_BASE_URL=http://localhost:11434/v1
```

Это не routing setting.

## Provider-limit bridges

```text
CODEX_BIN=
BAILIAN_CLI_BIN=
OPENCODE_LIMITS_CACHE_SECONDS=60
OPENCODE_TUI_LIMITS_COMMAND_TIMEOUT_MS=10000
```

Если `codex` и `bl` доступны через `PATH`, явные пути не нужны.

## RAG

```text
MCP_RAG_ENABLED=auto
MCP_RAG_ROOT=
MCP_RAG_BIN=
```

`MCP_RAG_ENABLED`:

- `auto` — попробовать найти usable RAG;
- `0` — намеренно выключить;
- `1` — сделать обязательным для установки.

В режиме `auto`/`1` installer ищет RAG через explicit path, соседний checkout и стандартный user location. Для production-like установки лучше задавать explicit `MCP_RAG_ROOT` и `MCP_RAG_BIN`.

## Ponytail

```text
PONYTAIL_ENABLED=1
PONYTAIL_DEFAULT_MODE=full
# PONYTAIL_UPSTREAM_URL=https://github.com/DietrichGebert/ponytail.git
# PONYTAIL_PIN_COMMIT=2ed6c52c9d7e5e56942508591085fd45dea277d3
# PONYTAIL_CHECKOUT_DIR=
```

`PONYTAIL_ENABLED=1` включает managed OpenCode V2 plugin и делает provisioning обязательным. `0` убирает plugin из отрендеренного `opencode.json`, но не удаляет его checkout. `PONYTAIL_DEFAULT_MODE` принимает `off`, `lite`, `full` или `ultra` и записывается только при отсутствии `.ponytail-active`.

По умолчанию используется pinned upstream commit `2ed6c52c9d7e5e56942508591085fd45dea277d3`. Installer принимает только полный SHA и обновляет существующий checkout только fast-forward-ом после проверки origin `https://github.com/DietrichGebert/ponytail.git`, ветки `main`, чистого состояния и того, что pin является предком `origin/main`.

Состояние режима находится в `$XDG_CONFIG_HOME/opencode/.ponytail-active` или `~/.config/opencode/.ponytail-active`. Менять режим во время работы можно командами `/ponytail`, `/ponytail lite`, `/ponytail full`, `/ponytail ultra` и `/ponytail off`.

## Repository index

```text
OPENCODE_REPO_EMBEDDINGS=auto
OPENCODE_REPO_EMBED_MODEL=sentence-transformers/all-MiniLM-L6-v2
```

`auto` использует sentence-transformers при наличии и иначе deterministic hashed embeddings. Внешний model API для repository index не обязателен.

## Runtime/tool policy

```text
OPENCODE_MCP_RATE_LIMIT=120
OPENCODE_TOOL_ARTIFACT_THRESHOLD=24000
OPENCODE_LOOP_LIMIT=3
OPENCODE_VERIFY_PIPELINE=auto
OPENCODE_VERIFY_TIMEOUT=120
OPENCODE_VERIFY_AUTOFIX=1
OPENCODE_AUTO_REVIEW=smart
OPENCODE_STUCK_PROGRESS_POLLS=100
OPENCODE_STUCK_ACTION=warn
```

## Secrets

```text
OPENCODE_SECRET_PREFIXES=TOKEN_PLAN_;OPENAI_;GITHUB_;MCP_;QDRANT_;HF_
OPENCODE_SECRET_SCOPES=
OPENCODE_SHELL_SECRET_REFS=
```

Secret values не сериализуются в browser/runtime snapshots.

## Sandbox

```text
OPENCODE_ALLOW_FULL_MACHINE=0
OPENCODE_SANDBOX_DOCKER_IMAGE=python:3.12-slim
OPENCODE_DOCKER_NETWORK=0
OPENCODE_DOCKER_READONLY=0
```

`full-machine` требует explicit opt-in. Normal writable work использует repo-scoped policy.

## Backend discovery

```text
OPENCODE_BACKEND_URL=
OPENCODE_BACKEND_USERNAME=opencode
OPENCODE_BACKEND_PASSWORD=
OPENCODE_SERVICE_FILE=
OPENCODE_LEGACY_AUTH_FILE=
```

Нормальный режим — OpenCode V2 service discovery. Explicit backend задавайте только когда действительно нужен pin.

## Installer

```text
OPENCODE_CONFIG_DIR=
OPENCODE_AUTH_FILE=
OPENCODE_CONFIG_BACKUP_DIR=
OPENCODE_CONFIG_BACKUP_KEEP=20
INSTALL_OPENCODE_CONFIG=1
CUSTOM_OPENCODE_INSTALL_SELFTEST=1
```

Для shared OpenCode V2 `OPENCODE_CONFIG_DIR` обычно остаётся пустым, чтобы использовать canonical global config.

## Optional OpenCode auth backup

```text
OPENCODE_OPENAI_ACCESS=CHANGE_ME
OPENCODE_OPENAI_REFRESH=CHANGE_ME
OPENCODE_OPENAI_EXPIRES=0
OPENCODE_OPENAI_ACCOUNT_ID=CHANGE_ME
OPENCODE_ZEN_KEY=CHANGE_ME
OPENCODE_GO_KEY=CHANGE_ME
```

Installer записывает только реально заданные значения, отличные от `CHANGE_ME`.

## Recommended minimal `.env`

```text
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=<set>
OPENCODE_AUTH_ALLOW_BASIC=0
OPENCODE_AUTH_COOKIE_SECURE=auto
OPENCODE_WEB_HOST=localhost
OPENCODE_WEB_PORT=4098
OPENCODE_WEB_ALLOW_LOCAL=0
OPENCODE_PROJECT_ROOTS=~/code;~/projects

TOKEN_PLAN_API_KEY=<set>
TOKEN_PLAN_ANTHROPIC_BASE_URL=https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1
TOKEN_PLAN_OPENAI_BASE_URL=https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1

OPENCODE_PLANNER_MODEL=bailian-cli/qwen3.8-max
OPENCODE_BUILDER_MODEL=bailian-cli/qwen3.7-plus
OPENCODE_READER_MODEL=bailian-cli/qwen3.8-flash
OPENCODE_REVIEW_MODEL=bailian-cli/deepseek-v4-pro-0813
OPENCODE_LONG_HORIZON_MODEL=bailian-cli/glm-5.2
OPENCODE_ORCHESTRATED_MODEL=bailian-cli/qwen3.8-orchestrated

MCP_RAG_ENABLED=0
CUSTOM_OPENCODE_INSTALL_SELFTEST=1
INSTALL_OPENCODE_CONFIG=1
```

## Проверка

Перед install/update:

```bash
set -a
source .env
set +a
./scripts/verify.sh
python3 scripts/model-routing-effort-smoke.py
```

Verifier также ищет случайно закоммиченные secrets, personal absolute paths и запрещённые routing regressions.
