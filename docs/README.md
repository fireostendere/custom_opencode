# Документация custom_opencode

`custom_opencode` — переносимый комплект поверх OpenCode V2: web/PWA-интерфейс, custom web auth, Alibaba/Qwen routing, Runtime V2/V3 control plane, безопасное открытие локальных проектов, self-test и опциональный инженерный RAG.

## С чего начать

- [Установка и обновление](installation.md) — новая установка, миграция, login/session settings, self-test, systemd и обновления.
- [Конфигурация `.env`](configuration.md) — web auth, runtime/scheduler, секреты, пути и рекомендуемые значения.
- [Web UI, авторизация и оформление](web-ui.md) — custom login, remembered session, mobile drawer, темы, accent colors и микроанимации.
- [Архитектура и возможности](architecture.md) — компоненты системы и границы ответственности.
- [Server Runtime V3](server-runtime-v3.md) — durable tasks/checkpoints, capability registry, adaptive scheduler, native compaction, AST/embedding repo index, MCP Code Mode gateway, sandbox/secret boundary, shared RAG, worktrees, replay и telemetry.
- [Server Runtime V2](server-runtime-v2.md) — фундамент task/control runtime и история перехода к V3.
- [Permission control plane](control-plane.md) — R0–R4 risk policy, safe auto-approval, project rules и audit.
- [Модели и routing](models-and-routing.md) — web Build, TUI Plan, direct/server profiles, adaptive local/cloud routing и orchestration.
- [Интеграция RAG](rag.md) — `mcp-rag`, lifecycle и server-managed retrieval.
- [`/rag-start`](rag-start.md) — запуск/проверка RAG без LLM-токенов.
- [Эксплуатация и recovery](operations.md) — systemd, update, backup, logs и recovery.
- [Troubleshooting](troubleshooting.md) — типовые симптомы, включая login/theme/mobile cases.
- [TUI add wizard](tui-add-wizard.md) — `/add` для provider/model/MCP/skill/orchestration, тестовые сценарии и regression.
- [TUI server wizard](tui-server-wizard.md) — `/server` для управления web server: статус, запуск/остановка, автозапуск, порт/адрес, пользователи.
- [VSCode: хоткеи терминала](vscode-terminal.md) — проброс `ctrl+f/p/r/b` в OpenCode TUI вместо команд VSCode (перехват по фокусу).

## Репозитории

- `custom_opencode` — UI, web auth, OpenCode config, Runtime V2/V3, model profiles, MCP gateway/wiring, installer и self-test;
- `mcp-rag` — инженерная база знаний: registry, Qdrant, embeddings/BM25/reranker, ingestion и knowledge tools.

`custom_opencode` работает без `mcp-rag`. При отключённом/отсутствующем RAG обычные OpenCode/runtime workflows остаются рабочими.

## Базовая схема

```text
Browser / PWA / CLI
    |
    +--> custom login -> signed HttpOnly web session
    |
    v
server_workflow.py
    |
    +--> Runtime V2/V3
    |       +--> SQLite/WAL tasks / checkpoints / events
    |       +--> capability registry + model profiles + adaptive scheduler
    |       +--> context planner + native compaction
    |       +--> repo AST/symbol/embedding/dependency/Git index
    |       +--> cache / artifacts / mailbox / handoff / verification / review
    |       +--> sandbox / worktrees / scoped secrets / replay / telemetry
    |       +--> Task Center + runtime dashboards
    |
    +--> permission control plane (R0-R4)
    |
    +--> OpenCode V2 native model/tool/session/MCP engine
            |
            +--> web Build / TUI Plan surface
            +--> manual direct model
            +--> adaptive/orchestrated/review server profiles
            +--> optional kb / mcp-rag
            +--> optional universal Tool Fabric (private layers → inspect → run)
```

## Основные safety/UX invariants

[Universal Tool Fabric: общее ядро и приватные слои](tool-fabric.md).

- web execution mode всегда Build; `plan*` доступен в TUI/CLI как native compatibility ID;
- direct/manual model selection не меняется adaptive scheduler-ом;
- auto local/cloud routing работает только внутри явно выбранного server profile;
- R3/R4 permission floor остаётся interactive;
- remembered web login использует signed HttpOnly cookie, password не хранится в browser storage;
- legacy Basic Auth выключен по умолчанию;
- project/scratch/worktree containment проверяется server-side;
- secrets не сериализуются в browser/runtime snapshots;
- PWA не кэширует auth-sensitive HTML/API response как offline shell;
- RAG/Ollama могут деградировать отдельно, не блокируя обычный OpenCode path.
