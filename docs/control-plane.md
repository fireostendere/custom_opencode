# Server control plane и permission policy

`custom_opencode` содержит server-side control plane поверх OpenCode V2. Его первая задача — убрать шумные подтверждения безопасных операций, не превращая web-клиент или модель в источник истины для разрешений.

## Модель доверия

Browser передаёт control plane только:

- `sessionID`;
- `permissionID`.

Action, command и resources не принимаются от browser как основание для разрешения. Сервер повторно получает фактический pending permission из OpenCode V2, проверяет, что он относится к той же session, классифицирует риск и только после этого может отправить `once` reply в native OpenCode permission API.

Если запрос исчез, backend недоступен, payload неизвестен или классификация неоднозначна, решение — `ask`. Policy должна ошибаться в сторону обычной интерактивной permission card.

## Уровни риска

```text
R0  read-only / inspection
R1  bounded local compute или разрешённый read-only network fetch
R2  workspace-local mutation
R3  external, ambiguous или potentially destructive action
R4  sensitive path / credential boundary
```

Уровень риска служит объяснимым audit metadata. Разрешение определяется policy preset и конкретными guardrails, а не только числом уровня.

## Presets

Настройка:

```text
OPENCODE_PERMISSION_POLICY=workspace
```

Поддерживаются три значения.

### `safe`

Автоматически проходят только доказуемые read-only действия и узкий allowlist безопасных inspection-команд. Изменения файлов остаются интерактивными.

### `workspace` — default

Автоматически разрешаются:

- `read`, `glob`, `grep`, `list`, `lsp` и read-only `kb` tools;
- безопасные inspection shell commands вроде `cat README.md`, `rg`, `git status`, `git diff` без output mutation;
- bounded check/test commands вроде `pytest`, `npm test`, `npm run lint`, `cargo check`;
- `edit/write/patch`, только когда target известен и находится внутри текущего workspace.

### `autonomous`

Сохраняет все ограничения `workspace` и дополнительно разрешает read-only `webfetch`. Destructive/external/sensitive действия всё равно не становятся автоматически разрешёнными.

## Что всегда остаётся интерактивным

Control plane не auto-approves:

- неизвестные shell commands;
- compound shell (`&&`, `;`, pipes, redirects, command substitution);
- `rm`, `sudo`, package/system mutation и аналогичные команды;
- `git push` и другие внешние side effects;
- выход абсолютным path за текущий workspace;
- `.env`, SSH/GPG keys, credentials/secrets paths;
- `external_directory`;
- `subagent`/`task` permission escalation;
- `kb_knowledge_ingest`;
- запросы с неполным или неоднозначным payload.

Автоматический ответ всегда `once`. Control plane никогда не превращает собственное решение в persistent `always` grant.

## Audit

По умолчанию:

```text
OPENCODE_PERMISSION_AUDIT=1
```

Лог хранится в:

```text
~/.local/state/custom-opencode/permission-audit.jsonl
```

Путь можно переопределить:

```text
CUSTOM_OPENCODE_STATE_DIR=
```

Audit содержит policy version, preset, action, risk, effect, session/permission IDs, краткий redacted resource hint и fingerprint. Очевидные значения `token`, `api_key`, `password`, `secret`, `authorization` редактируются перед записью.

Отключение audit не влияет на allow/ask decision.

## HTTP endpoints

Authenticated web server предоставляет:

```text
GET  /client-control-plane.json
POST /client-permission-evaluate.json
```

Второй endpoint принимает только IDs. Он не является универсальным endpoint «разрешить команду».

## Model profiles

Control-plane snapshot также описывает текущие model profiles:

```text
ordinary                   → build-direct / plan-direct
qwen3.8-max-orchestrated   → build / plan + fast-reader
```

Это metadata для дальнейшего server-side routing. Оркестрация остаётся выбором варианта модели, а не отдельным пользовательским режимом.

## Тестирование

Политика не требует LLM inference. Основной regression smoke:

```bash
python3 scripts/control-plane-smoke.py
```

Он проверяет low-risk allow, sensitive/destructive deny-to-ask boundaries, audit redaction и server integration, где решение принимается по фактическому backend permission request.

Полная repository regression по-прежнему начинается с:

```bash
./scripts/verify.sh
```

Clean install/update/web-server regression выполняется отдельным скриптом и в CI из изолированного HOME.
