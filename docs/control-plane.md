# Permission control plane

`custom_opencode` использует детерминированный server-side permission gate поверх native OpenCode permission API. Модель не оценивает безопасность собственных действий и не получает возможность расширять себе права.

## Risk levels

| Risk | Примеры | Поведение |
| --- | --- | --- |
| `R0` | read/list/grep, `git status`, `git diff` | auto в любом preset |
| `R1` | bounded `pytest`, lint/check/build; network read только в `autonomous` | auto согласно preset |
| `R2` | edit/write/patch внутри текущего workspace | auto в `workspace`/`autonomous` |
| `R3` | destructive/ambiguous shell, `git push`, external directory, subagent/task escalation, RAG ingest | всегда спрашивать |
| `R4` | `.env`, credentials, SSH/GPG keys и другие sensitive paths | всегда спрашивать |

`R3/R4` являются hard boundary: project `allow` не может превратить их в automatic approval.

## Presets

`OPENCODE_PERMISSION_POLICY=safe`

- автоматически только `R0`;
- workspace writes/checks остаются интерактивными.

`OPENCODE_PERMISSION_POLICY=workspace` — default.

- `R0` read-only;
- bounded `R1` test/check commands;
- `R2` workspace-local edits.

`OPENCODE_PERMISSION_POLICY=autonomous`

- всё из `workspace`;
- дополнительно read-only network fetch `R1`;
- `R3/R4` всё равно спрашиваются.

## Project permission rules

Project settings сохраняют ordered rules:

```text
action glob + resource glob -> ask | allow | deny
```

Первое совпавшее правило имеет приоритет:

- `ask` всегда оставляет native permission card;
- `deny` автоматически отклоняет совпавшее действие;
- `allow` разрешает автоматический ответ только при классификации `R0-R2`;
- при `R3/R4` даже matching `allow` остаётся интерактивным.

Кнопка `Разрешать в проекте` создаёт explicit project allow rule, но не отключает hard risk boundary.

## Trust boundary

Browser передаёт control plane только `sessionID`/`permissionID` для явной проверки. Сервер заново получает pending permission непосредственно из OpenCode и классифицирует backend payload. Клиент не может подменить destructive action на harmless read.

Background pass встроен в существующий `server_features` worker. Второй scheduler/agent runtime не создаётся.

## Audit

Automatic decisions записываются в:

```text
$XDG_STATE_HOME/custom-opencode/permission-audit.jsonl
```

или рядом с `CUSTOM_OPENCODE_FEATURE_STATE`, если задан custom state file.

Ресурсы ограничиваются по длине, типовые secret assignments редактируются, дополнительно сохраняется короткий fingerprint. Audit можно отключить через:

```bash
OPENCODE_PERMISSION_AUDIT=0
```

## Local models

Control plane не выбирает модели, не проверяет GPU/process load и не запускает/выгружает Ollama. Model routing остаётся отдельным существующим механизмом.
