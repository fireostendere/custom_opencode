# Troubleshooting

## Installer останавливается на pre-install verification

Это означает, что проблема найдена до изменения runtime config.

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
- installed unit запускает production entrypoint `app/server_workflow.py`;
- Python path существует;
- выбранный port свободен.

После исправления:

```bash
systemctl --user daemon-reload
systemctl --user restart opencode-web-client.service
```

## `server-import: FAIL`

Обычно это invalid/missing runtime environment или ошибка Python import.

```bash
python3 -m py_compile app/server.py app/server_ext.py app/server_plus.py app/server_rag.py app/server_features.py app/server_workflow.py
```

И `.env`:

```bash
set -a
source .env
set +a
```

## `runtime-config: FAIL`

Проверьте `OPENCODE_CONFIG_DIR`. Если variable не задан, ожидается `~/.config/opencode/opencode.json`.

Повторный installer должен заново отрендерить config из tracked template. Не редактируйте generated runtime JSON как единственный источник истины — изменения будут потеряны при следующем install.

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
- проверьте `OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD`;
- проверьте port collision;
- посмотрите journal web service.

Штатный web UI использует `/login.html` и signed cookie session. Legacy Basic Auth не нужен для обычного browser smoke.

## Chrome всё ещё показывает системное окно логин/пароль

Текущий web server для обычной авторизации не отправляет `WWW-Authenticate`. Если Chrome показывает native Basic Auth dialog, challenge приходит не от актуального UI path.

Проверьте по порядку:

1. в `.env` стоит `OPENCODE_AUTH_ALLOW_BASIC=0`;
2. web service действительно перезапущен на текущем checkout;
3. systemd unit запускает `server_workflow.py` из ожидаемого каталога;
4. перед `custom_opencode` нет reverse proxy, который сам добавляет Basic Auth;
5. браузер открывает web port custom_opencode, а не backend OpenCode напрямую.

После изменения `.env`:

```bash
systemctl --user restart opencode-web-client.service
```

Если native prompt остаётся, посмотрите response headers на первом HTML request: источник проблемы — слой, который добавляет `WWW-Authenticate`.

## После login снова возвращает на login

Сначала проверьте cookie policy и HTTPS termination.

Relevant `.env`:

```text
OPENCODE_AUTH_COOKIE_SECURE=auto
OPENCODE_AUTH_SESSION_SECONDS=86400
OPENCODE_AUTH_REMEMBER_SECONDS=2592000
```

Типовые причины:

- reverse proxy не передаёт `X-Forwarded-Proto: https` или `Forwarded: proto=https`;
- `OPENCODE_AUTH_COOKIE_SECURE=1` используется поверх обычного HTTP, поэтому браузер не отправляет Secure cookie;
- hostname/origin меняется между login и app;
- web password был изменён — старые подписанные sessions намеренно становятся недействительными.

Для HTTPS за нормальным reverse proxy оставляйте `OPENCODE_AUTH_COOKIE_SECURE=auto`.

## После повторного входа открылся не тот диалог

Client-side re-auth хранит полный route в `sessionStorage` под `opencode:web:auth-resume-v1`. Login URL также несёт `next=`.

Если возврат сломался после frontend merge:

- проверьте, что `auth-ui.js` загружается до остальных application modules;
- убедитесь, что route имеет форму `#/session/<id>`;
- не очищайте `sessionStorage` между redirect и login вручную.

Обычный logout/re-auth должен возвращать в ту же session.

## Светлая/системная тема выглядит как тёмная после обновления

Appearance хранится в `opencode:web:appearance-v1`. Основной UI загружает `appearance.css` последним, а PWA cache version меняется при appearance changes.

Проверьте:

1. hard reload страницы;
2. в DevTools/Application активен новый service worker;
3. при необходимости удалите только appearance preference и выберите тему снова:

```js
localStorage.removeItem('opencode:web:appearance-v1')
```

Не требуется очищать auth cookie или project state.

Для `Системная` также проверьте `prefers-color-scheme` устройства/браузера.

## Анимации нежелательны или не должны проигрываться

UI уважает системный `prefers-reduced-motion: reduce`. Включите уменьшение движения в настройках ОС/браузера — dialogs, toast, drawer и остальные microanimations станут практически мгновенными.

## Sidebar на телефоне не закрывается

На mobile drawer должен закрываться тремя независимыми способами:

- swipe справа налево;
- browser/Android Back;
- tap/click вне sidebar, включая затемнённый scrim.

Если после frontend merge один путь перестал работать, проверьте загрузку `mobile-ui.js` и `sidebar-mobile.css`, а также отсутствие другого overlay с `z-index` выше scrim, который перехватывает pointer event.

## Панель `Лимиты` снова разворачивается после reload

Состояние хранится в `custom-opencode:limits-collapsed`. Если browser storage запрещён/очищается, панель вернётся к default open — это ожидаемая деградация.

## RAG отображается как disabled

Installer включает `kb`, только если найден executable.

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

Это повреждённое/неполное состояние индекса. `/rag-start` не должен создавать пустую collection и маскировать проблему.

Нужен explicit rebuild по документации `mcp-rag`. Перед rebuild сделайте backup registry/config и убедитесь, что исходные sources доступны.

## MCP `kb: connected`, но tools не работают

`connected` подтверждает transport, но не полный protocol/tool path. Doctor делает independent MCP probe.

Проверьте venv dependencies и `MCP_RAG_BIN`. Прямой запуск stdio MCP без protocol client не является полноценным тестом — используйте Doctor/RAG probe scripts или tests из репозитория.

## Direct MCP probe PASS, OpenCode MCP FAIL

RAG process работает, но OpenCode не подключил server к текущему workspace.

```text
/rag-start quick
```

Команда выполняет dynamic add/connect к выбранному workspace и после успеха сохраняет `kb.disabled=false`.

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

- orchestrated profile использует internal `build` agent;
- permission `subagent fast-reader → allow`;
- `fast-reader.model=bailian-cli/qwen3.6-flash`;
- отсутствие automatic Ollama route;
- upstream session/subagent API после OpenCode upgrade.

Visible UI при этом остаётся Build-only.

## На телефоне model picker открывает клавиатуру

В текущем UI `modelSearch` должен быть hidden compatibility input.

Если клавиатура снова появляется после merge/upstream UI change:

```bash
./scripts/verify.sh
```

Verifier проверяет наличие hidden input marker.

## Не видно нужную папку в `Папки на ПК`

Проверьте `OPENCODE_PROJECT_ROOTS`, например:

```text
OPENCODE_PROJECT_ROOTS=~/code;~/projects
```

Folder browser намеренно не выходит за разрешённые roots, скрывает dot-directories и блокирует symlink escape.

## После обновления пропали старые секреты

Installer не должен заменять реальные credentials на `CHANGE_ME`, но `.env` не управляется Git.

Восстановите `.env` из собственного backup. `opencode.json.backup.*` не содержит полный набор host secrets и не заменяет backup `.env`/auth storage.

## Когда можно отключить install self-test

Только как временный recovery:

```text
CUSTOM_OPENCODE_INSTALL_SELFTEST=0
```

После восстановления верните `CUSTOM_OPENCODE_INSTALL_SELFTEST=1` и повторите `./scripts/install.sh` или self-test вручную.
