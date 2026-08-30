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

`OPENCODE_SERVER_PASSWORD` обязателен. Обычный web UI использует собственную login page и подписанную `HttpOnly` cookie, а не browser-native Basic Auth prompt.

- `OPENCODE_AUTH_SESSION_SECONDS` — TTL обычной session cookie; по умолчанию 24 часа. Без `Запомнить вход` cookie не получает `Max-Age` и остаётся browser-session cookie.
- `OPENCODE_AUTH_REMEMBER_SECONDS` — TTL при включённом `Запомнить вход`; по умолчанию 30 дней.
- `OPENCODE_AUTH_COOKIE_SECURE=auto` — ставит `Secure` при HTTPS, обнаруженном через reverse-proxy headers. Можно принудительно задать `1` или `0`.
- `OPENCODE_AUTH_ALLOW_BASIC=0` — рекомендуемый default. `1` нужен только для старых внешних clients/scripts, которые всё ещё отправляют `Authorization: Basic`.
- `OPENCODE_WEB_ALLOW_LOCAL=0` — рекомендуемый и безопасный default. При явном `1` bypass разрешён только прямому localhost request: loopback TCP peer + loopback `Host` + отсутствие forwarding headers. Reverse-proxy/LAN/Tailscale traffic никогда не наследует localhost bypass.

Пароль в браузере приложением не сохраняется. `Запомнить вход` хранит только пользовательское предпочтение/username в localStorage и долгоживущую подписанную HttpOnly cookie. `Logout` отзывает текущий token в lifetime server process; изменение web password инвалидирует все старые tokens криптографически.

`OPENCODE_WEB_HOST=localhost` — безопасный default. Если UI публикуется в LAN/tailnet, используйте TLS/Tailscale/reverse proxy, оставляйте `OPENCODE_WEB_ALLOW_LOCAL=0` и не выставляйте plaintext HTTP в недоверенную сеть.

`OPENCODE_SCRATCH_DIRECTORY` задаёт root для изолированных quick-session directories. Пустое значение приводит к default `~/opencode-scratch`.

`OPENCODE_PROJECT_ROOTS` — список разрешённых roots для `Проекты → Папки на ПК`, разделитель `;`:

```text
OPENCODE_PROJECT_ROOTS=~/code;~/projects
```

Чем уже список, тем меньше filesystem surface доступна web folder browser.

## Browser-only UI state

Тема/акцент, состояние `Лимиты`, remembered username/checkbox и drafts не относятся к `.env`. Они хранятся в browser local/session storage.

Основные ключи:

```text
opencode:web:appearance-v1
custom-opencode:limits-collapsed
opencode:web:login-prefs-v2
opencode:web:auth-resume-v1   # sessionStorage
```

`appearance-v1` содержит только `theme` (`system|light|dark`) и hex accent color. Секретов в этих keys быть не должно.

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
OPENCODE_TUI_LIMITS_COMMAND_TIMEOUT_MS=10000
```

Если `codex` и `bl` доступны через `PATH`, явные пути не нужны.

- Codex bridge читает rate limits через локальный `codex app-server` RPC.
- Bailian bridge читает Token Plan usage через `bl usage token-plan --output json`.
- Browser получает нормализованные данные, а не OAuth/API credentials.
- TUI запускает эти CLI без shell interpolation; каждый child process bounded watchdog-ом. `OPENCODE_TUI_LIMITS_COMMAND_TIMEOUT_MS` ограничен helper-ом диапазоном 500–30000 мс.
- `limits-header` и `limits-panels` разделяют один single-flight refresh с reference-counted ownership, поэтому unload одного surface не выключает обновление второго.

## RAG

```text
MCP_RAG_ENABLED=auto
MCP_RAG_ROOT=
MCP_RAG_BIN=
```

`MCP_RAG_ENABLED` задаёт намерение установки:

- `auto` — default; installer пытается найти usable RAG и включает его только если checkout/executable доступны;
- `0` — RAG намеренно выключен; autodetect не выполняется, `kb` рендерится disabled, `rag-quick` в post-install self-test становится `SKIP`;
- `1` — RAG обязателен; если usable checkout/executable не найден, установка завершается ошибкой до runtime self-test.

В режиме `auto` или `1` installer ищет RAG в порядке:

1. `MCP_RAG_ROOT`;
2. соседний `../mcp-rag`;
3. `~/mcp-rag`.

Для предсказуемой production-like установки лучше задать абсолютные пути:

```text
MCP_RAG_ENABLED=1
MCP_RAG_ROOT=/absolute/path/to/mcp-rag
MCP_RAG_BIN=/absolute/path/to/mcp-rag/.venv/bin/knowledge-mcp
```

Если RAG checkout лежит рядом, но его пока не нужно подключать, укажите явно:

```text
MCP_RAG_ENABLED=0
```

При `CUSTOM_OPENCODE_INSTALL_SELFTEST=1` и реально включённом RAG install/update теперь делает два уровня проверки без LLM/API inference:

1. bounded `rag-quick`: Qdrant/corpus/index readiness + MCP connect/protocol;
2. `scripts/rag-live-regression.py`: full preflight + один local retrieval smoke + прямой MCP `knowledge_search`.

То есть RAG-enabled update не считается успешным, если корпус формально найден, но retrieval или MCP tool contract уже сломан.

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

`QWEN_QUOTA_PROBE_ENABLED=0` оставляет install/restart и обычный runtime без автоматического LLM inference. Значение `1` явно включает периодический one-token probe для decoration заголовков сессий; панель лимитов через Bailian CLI не требует включать этот probe.

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

Для shared OpenCode V2 оставляйте `OPENCODE_CONFIG_DIR` пустым: используется канонический global root `~/.config/opencode`. Installer отклоняет другой путь, потому что обычный shared launcher после рестарта иначе вернётся к стандартному профилю и runtime перестанет соответствовать установленному config.

Если `OPENCODE_AUTH_FILE` пуст, используется `~/.local/share/opencode/auth.json`.

`CUSTOM_OPENCODE_INSTALL_SELFTEST=1` должен оставаться включённым. При включённом RAG он включает реальный zero-token retrieval regression. `0` предназначен только для аварийного recovery, когда сломанный runtime не позволяет installer завершиться.

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
TOKEN_PLAN_PROBE_MODEL=qwen3.8-max

MCP_RAG_ENABLED=0
MCP_RAG_ROOT=
MCP_RAG_BIN=

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
./scripts/verify.sh
```

Verifier специально ищет случайно закоммиченные секреты, personal absolute paths и сетевые literals в tracked source. `.env` из проверки исключён.
