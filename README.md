# custom_opencode

Переносимый комплект поверх OpenCode V2: собственный ChatGPT-подобный web/PWA client, Alibaba role routing, серверный Runtime V2/V3 control plane, безопасная работа с проектами, self-test и опциональный инженерный RAG через MCP.

## Что предоставляет

### Web/PWA UX

- custom login page вместо browser-native Basic Auth prompt;
- signed `HttpOnly; SameSite=Strict` web sessions, `Запомнить вход`, logout и возврат в исходный `#/session/...` после re-auth;
- root sessions в sidebar и isolated quick-session workspaces;
- Build-only пользовательский execution surface;
- web- и TUI-model picker с зеркальной секцией favorites: модель остаётся и в исходной группе;
- session-scoped model, effort и Build/Plan controls без переноса выбора между диалогами;
- копирование диалога с контекстом и подтверждаемый перенос через handoff между проектами;
- одна контекстная кнопка composer: send / cancel / persistent queue;
- native OpenCode questions: single/multi-select, descriptions и custom answer;
- session-scoped compact permission cards и project allow/deny policies;
- Changes/Review: file stats, hunks, safe file/hunk revert;
- orchestration trace, runtime/RAG/queue/status surfaces;
- light / dark / system theme, accent color и reduced-motion-aware микроанимации;
- mobile drawer, provider limits, Markdown/code/tool/reasoning renderers, files, clipboard images, Git/VCS UI, drafts, notifications и deep links.

### Server Runtime V2/V3

- SQLite/WAL durable task queue с priority, dependencies, cancel, pause/resume и recovery;
- checkpoints, event history, artifacts и per-stage token/cost accounting;
- Task Center и Runtime dashboard;
- model capability registry и profiles `direct`, `fast`, `build`, `architect`, `critical`, `research`, `long-horizon`;
- provider-pinned role routing без hidden host/device model switching;
- adaptive reasoning effort `auto / minimal / low / medium / high / max`;
- AST/symbol repository index, embeddings, dependency graph, bounded Git graph и semantic symbol diff;
- bounded dynamic context + native OpenCode durable compaction;
- pre-execution read/tool-result cache с Git-aware invalidation;
- large-output artifact storage с range/search;
- structured mailbox, typed handoff и bounded speculative research;
- verification pipeline, failure classifier, independent review gate, loop/stuck/conflict detection;
- isolated Git worktree tasks, patch ownership и fail-closed merge/cleanup;
- OpenCode-central MCP Code Mode/lazy loading + server policy/rate-limit/health layer;
- scoped Secret Broker и enforced sandbox profiles `safe`, `repo-write`, `docker`, `wsl`, gated `full-machine`;
- session branching, replay без новых model calls, telemetry и remote authenticated task API.

### Knowledge / providers / operations

- Alibaba Cloud Token Plan и OpenAI/Codex provider support;
- role stack `Qwen 3.8 Max planner → Qwen 3.8 Flash reader → Qwen 3.7 Plus builder → DeepSeek V4 Pro reviewer`, все non-OpenAI orchestration roles через Alibaba Cloud/Bailian;
- GLM 5.2 как optional long-horizon executor через Alibaba Cloud/Bailian;
- optional `mcp-rag` через `kb` MCP;
- `/rag-start`;
- pre-install verifier, Runtime V2/V3 smokes и post-install zero-LLM-token self-test;
- user systemd deployment и `custom-opencode-update`.

## Model routing

Manual/direct selection всегда авторитетна:

```text
конкретная вручную выбранная модель
    → используется ровно выбранный provider/model
```

Managed profiles используют role-based provider-pinned routing:

```text
Fast
    → Alibaba Qwen 3.8 Flash / low

Build
    → Alibaba Qwen 3.7 Plus / medium
    → Flash reader только когда нужен широкий поиск
    → Max только при реальном escalation

Architect
    → Alibaba Qwen 3.8 Max / high planner
    → Alibaba Qwen 3.8 Flash / low reader
    → Alibaba Qwen 3.7 Plus / medium builder

Critical
    → Alibaba Qwen 3.8 Max / max planner
    → Alibaba Qwen 3.8 Flash / low reader
    → Alibaba Qwen 3.7 Plus / high builder
    → Alibaba DeepSeek V4 Pro 0813 / max reviewer
```

`Research` и `Long Horizon` доступны как специализированные server profiles. Внутренний `review` profile provider-pinned на Alibaba DeepSeek V4 Pro 0813 и используется automatic review tasks.

Host load, GPU state, запущенные игры или доступность другого inference endpoint не меняют model route.

Подробнее: [Модели и routing](docs/models-and-routing.md), [Role routing and effort](docs/model-routing-effort.md), [Server Runtime V3](docs/server-runtime-v3.md).

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

`max` означает «используй самый высокий реально поддерживаемый reasoning effort выбранной model/provider pair». Это не означает, что literal `max` всегда отправляется в API.

Нормальная coding escalation:

```text
Qwen 3.7 Plus / medium
    ↓ meaningful failed solution attempt
Qwen 3.7 Plus / high
    ↓ repeated stall / architecture contradiction
Qwen 3.8 Max / high
    ↓ exceptional/critical only
Qwen 3.8 Max / max
```

Один failed shell command или typo не считается причиной переключения модели.

## Composer и durable queue

```text
работы нет                         → ↑ Отправить
работа идёт + composer пустой      → × Отменить текущую работу
работа идёт + есть текст/вложение  → ↑ Отправить в очередь
```

`/client-queue.json` остаётся compatibility facade. В Runtime V2/V3 queued work хранится в SQLite/WAL, переживает reload/restart и поддерживает priority/dependencies/pause/resume/cancel/checkpoints.

## Авторизация

Обычный web UX использует `/login.html` + `/auth/login`, а не Chrome Basic Auth dialog.

После успешного входа сервер выдаёт подписанную `HttpOnly; SameSite=Strict` cookie. При `Запомнить вход` по умолчанию используется 30-дневный TTL. Password приложением в browser storage не сохраняется.

Если session истекла во время работы, `auth-ui.js` сохраняет полный route, включая `#/session/...`, и после login возвращает пользователя туда же.

Legacy Basic compatibility выключена по умолчанию:

```text
OPENCODE_AUTH_ALLOW_BASIC=0
```

## Permissions

Permission card показывается только в session, которой принадлежит pending request. После `Разрешить / Отклонить / Всегда` она скрывается сразу; stale polling не должен возвращать resolved request.

Краткое описание показывает конкретное действие — command/path/URL/subtask — вместо сырого payload. Полные детали остаются под disclosure.

Server permission control plane остаётся детерминированным. R3/R4 не могут быть понижены model-side или project allow rule.

## Runtime architecture

```text
Browser / PWA / OpenCode clients
    |
    v
server_workflow.py
    |
    +--> server_runtime.py      durable task lifecycle / queue / provider-pinned routing / verification
    +--> runtime_v3.py          context / index / sandbox / RAG / replay
    +--> runtime_v3_ext.py      worktree merge / MCP telemetry / runtime APIs
    +--> runtime_completion.py  previews / cache / retry accounting / remote actions
    +--> runtime_store.py       SQLite/WAL state
    +--> permission control plane
    +--> OpenCode V2 backend + central MCP host
```

OpenCode остаётся model/tool/session/MCP execution engine; custom runtime добавляет durable orchestration и policy вокруг него.

## Context / compaction

Runtime V3 использует native OpenCode durable compaction. Custom preflight budget рассчитывается от фактического model context limit и `contextPolicy.targetRatio`.

Повторный custom compact требует meaningful context growth; pending native compaction не дублируется. Смена role или effort сама по себе compaction не вызывает.

## Project settings

Project state может задавать persistent system instructions, model/profile, RAG policy и ordered permission rules. Folder browser ограничен `OPENCODE_PROJECT_ROOTS` и canonical/symlink containment.

## RAG

RAG опционален. При `MCP_RAG_ENABLED=0` или отсутствии usable `mcp-rag` обычные OpenCode/runtime workflows продолжают работать.

`/rag-start` может без LLM inference проверить/поднять Qdrant, corpus/index, подключить `kb` к текущему workspace и проверить MCP tools.

## Ponytail

В комплект включён OpenCode V2 plugin [Ponytail](https://github.com/DietrichGebert/ponytail) с фиксированным reviewed commit `2ed6c52c9d7e5e56942508591085fd45dea277d3`. По умолчанию installer:

- клонирует upstream в `$XDG_DATA_HOME/opencode/ponytail` или `~/.local/share/opencode/ponytail`;
- подключает его entry point через V2-поле `plugins` в глобальном `opencode.json`;
- сохраняет выбранный режим в `~/.config/opencode/.ponytail-active` только при первой установке;
- не копирует upstream skills, commands или hooks в конфигурацию этого репозитория.

Режим по умолчанию — `full`. В OpenCode доступны `/ponytail`, `/ponytail lite`, `/ponytail full`, `/ponytail ultra` и `/ponytail off`. Для сознательного отключения интеграции задайте `PONYTAIL_ENABLED=0` в `.env`; checkout при этом не удаляется.

Provisioning завершается ошибкой при неверном origin, dirty checkout, уходе с `main`, недоступном pin или попытке non-fast-forward обновления. Локальная проверка этого контракта:

```bash
./scripts/ponytail-provision-regression.sh
```

## Быстрый старт

```bash
cp .env.example .env
# заполнить .env
./scripts/verify.sh
./scripts/verify-runtime-v3.sh
python3 scripts/model-routing-effort-smoke.py
./scripts/install.sh
```

После установки:

```bash
custom-opencode
```

Обновление:

```bash
custom-opencode-update
```

Installer по умолчанию выполняет pre-install verification и post-install runtime self-test. Платный model inference автоматически не запускается.

## Документация

Полный индекс: [docs/README.md](docs/README.md).

Основные разделы:

- [Установка, миграция и обновление](docs/installation.md)
- [Конфигурация `.env`](docs/configuration.md)
- [Web UI, авторизация и оформление](docs/web-ui.md)
- [Архитектура и возможности](docs/architecture.md)
- [Server Runtime V2](docs/server-runtime-v2.md)
- [Server Runtime V3](docs/server-runtime-v3.md)
- [Модели и routing](docs/models-and-routing.md)
- [Role routing and reasoning effort](docs/model-routing-effort.md)
- [Permission control plane](docs/control-plane.md)
- [RAG integration](docs/rag.md)
- [`/rag-start`](docs/rag-start.md)
- [Эксплуатация и recovery](docs/operations.md)
- [Troubleshooting](docs/troubleshooting.md)

## Security defaults

- secrets/host URLs только в private `.env`/trusted service boundary;
- signed HttpOnly web session; legacy Basic off by default;
- recommended web bind — loopback или защищённый tailnet/reverse proxy;
- project/scratch containment;
- R0–R4 permission floor;
- direct manual model selection не меняется server router-ом;
- managed roles provider-locked;
- scoped secrets не сериализуются в browser/runtime snapshots;
- sandbox/worktree ownership checks до writable execution;
- auth/API/HTML responses не кэшируются service worker как offline app shell;
- install/update fail closed при critical self-test failure.
