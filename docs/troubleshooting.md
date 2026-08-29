# Troubleshooting

## Installer останавливается на pre-install verification

Это означает, что проблема найдена до изменения runtime config.

Запустите отдельно:

```bash
./scripts/verify.sh
```

Исправляйте первую конкретную ошибку. Не отключайте verifier только для того, чтобы installer завершился.

Типовые причины:

- syntax error после ручной правки;
- stale OpenCode V2 contract;
- неправильный model/provider allowlist;
- tracked secret/personal path;
- systemd entrypoint не совпадает с актуальным server layer;
- нарушена RAG/router invariant.

## `web-service: FAIL`

```bash
systemctl --user status opencode-web-client.service --no-pager
journalctl --user -u opencode-web-client.service -n 200 --no-pager
```

Проверьте:

- `.env` существует;
- `OPENCODE_SERVER_PASSWORD` задан;
- installed unit запускает `app/server_rag.py`;
- Python path существует;
- выбранный port свободен.

После исправления:

```bash
systemctl --user daemon-reload
systemctl --user restart opencode-web-client.service
```

## `server-import: FAIL`

Обычно это invalid/missing runtime environment или ошибка Python import.

Проверьте:

```bash
python3 -m py_compile app/server.py app/server_ext.py app/server_plus.py app/server_rag.py
```

И `.env`:

```bash
set -a
source .env
set +a
```

## `runtime-config: FAIL`

Проверьте runtime config path:

```text
OPENCODE_CONFIG_DIR
```

Если variable не задан, ожидается `~/.config/opencode/opencode.json`.

Повторный installer должен заново отрендерить config из tracked template.

Не редактируйте generated runtime JSON как единственный источник истины — изменения будут потеряны при следующем install.

## `opencode-backend: FAIL`

Проверьте, запущен ли OpenCode V2 backend и существует ли service discovery file.

Relevant `.env`:

```text
OPENCODE_BACKEND_URL
OPENCODE_BACKEND_USERNAME
OPENCODE_BACKEND_PASSWORD
OPENCODE_SERVICE_FILE
```

Если раньше использовался automatic service discovery, не задавайте случайный explicit URL.

## `web-http: FAIL`

Если service active, но HTTP check падает:

- проверьте `OPENCODE_WEB_HOST`/`PORT`;
- проверьте Basic Auth credentials;
- проверьте port collision;
- посмотрите journal web service.

## RAG отображается как disabled

Installer включает `kb`, только если найден executable.

Проверьте:

```bash
test -x /path/to/mcp-rag/.venv/bin/knowledge-mcp
```

И `.env`:

```text
MCP_RAG_ROOT=/absolute/path/to/mcp-rag
MCP_RAG_BIN=/absolute/path/to/mcp-rag/.venv/bin/knowledge-mcp
```

После исправления:

```bash
./scripts/install.sh
```

или:

```bash
custom-opencode-update
```

## `/rag-start quick` падает

Смотрите stage/detail в Doctor.

Проверьте RAG напрямую:

```bash
cd /path/to/mcp-rag
.venv/bin/python -m knowledge_base.runtime --json --no-start
```

Возможные состояния:

- Qdrant offline;
- Docker unavailable;
- corpus empty;
- collection missing;
- invalid settings;
- MCP executable broken;
- OpenCode workspace MCP connect failed.

## Qdrant offline

Для локальной loopback конфигурации:

```bash
cd /path/to/mcp-rag
docker compose up -d qdrant
docker compose ps
```

Или используйте bounded bootstrap:

```bash
.venv/bin/python -m knowledge_base.runtime --json
```

## Corpus есть, collection отсутствует

Это повреждённое/неполное состояние индекса.

`/rag-start` не должен создавать пустую collection и маскировать проблему.

Нужен explicit rebuild по документации `mcp-rag`. Перед rebuild сделайте backup registry/config и убедитесь, что исходные sources доступны.

## MCP `kb: connected`, но tools не работают

`connected` подтверждает transport, но не полный protocol/tool path.

Doctor делает independent MCP probe. Если он падает:

```bash
/path/to/mcp-rag/.venv/bin/knowledge-mcp
```

не является хорошим интерактивным тестом сам по себе, потому что stdio MCP ожидает protocol client. Используйте Doctor/RAG probe scripts или tests из репозитория.

Проверьте venv dependencies и `MCP_RAG_BIN`.

## Direct MCP probe PASS, OpenCode MCP FAIL

RAG process работает, но OpenCode не подключил server к текущему workspace.

Попробуйте:

```text
/rag-start quick
```

Он выполняет dynamic add/connect к выбранному workspace и после успеха сохраняет `kb.disabled=false`.

## RAG retrieval медленный в первый раз

Это нормально после idle unload. Embedding/reranker загружаются лениво.

Default:

```text
KB_MODEL_IDLE_SECONDS=600
```

Если RAM достаточно и latency важнее памяти, можно увеличить timeout или поставить `0` в RAG settings/env, чтобы отключить unload.

## Model catalog есть, inference не работает

Catalog check не доказывает provider execution.

Проверьте:

- `TOKEN_PLAN_API_KEY`;
- endpoint URL;
- Token Plan status/limits;
- Bailian CLI usage.

После этого можно вручную запустить минимальный Flash/Max inference smoke в Doctor. Эти проверки платные.

## Router config PASS, Router E2E FAIL

Если Max и Flash inference отдельно PASS, проблема вероятнее всего в delegation/subagent path.

Проверьте:

- `default_agent=build`;
- permission `subagent fast-reader → allow`;
- `fast-reader.model=bailian-cli/qwen3.6-flash`;
- отсутствие automatic Ollama route;
- upstream session/subagent API после OpenCode upgrade.

## На телефоне model picker открывает клавиатуру

В текущем UI `modelSearch` должен быть hidden compatibility input.

Если клавиатура снова появляется после merge/upstream UI change:

```bash
./scripts/verify.sh
```

Verifier проверяет наличие hidden input marker.

## Не видно нужную папку в `Папки на ПК`

Проверьте `OPENCODE_PROJECT_ROOTS`.

Например:

```text
OPENCODE_PROJECT_ROOTS=~/code;~/projects
```

Folder browser намеренно:

- не выходит за разрешённые roots;
- скрывает dot-directories;
- блокирует symlink, который resolve-ится наружу.

## После обновления пропали старые секреты

Installer не должен заменять реальные credentials на `CHANGE_ME`, но `.env` не управляется Git.

Восстановите `.env` из собственного backup. `opencode.json.backup.*` не содержит полный набор host secrets и не заменяет backup `.env`/auth storage.

## Когда можно отключить install self-test

Только как временный recovery:

```text
CUSTOM_OPENCODE_INSTALL_SELFTEST=0
```

После восстановления:

```text
CUSTOM_OPENCODE_INSTALL_SELFTEST=1
```

и обязательно повторите `./scripts/install.sh` или self-test вручную.
