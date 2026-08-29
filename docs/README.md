# Документация custom_opencode

`custom_opencode` — переносимый комплект поверх OpenCode V2: web/PWA-интерфейс, Alibaba/Qwen routing, безопасное открытие локальных проектов, диагностика, self-test, серверный task/control runtime и опциональный инженерный RAG.

## С чего начать

- [Установка и обновление](installation.md) — новая установка, миграция существующей установки, self-test, systemd и обновления.
- [Конфигурация `.env`](configuration.md) — основные переменные окружения, секреты, пути и рекомендуемые значения.
- [Архитектура и возможности](architecture.md) — компоненты системы и их границы ответственности.
- [Server Runtime V3](server-runtime-v3.md) — durable tasks/checkpoints, capability registry, adaptive scheduler, native compaction, AST/embedding repo index, MCP Code Mode gateway, enforced sandbox/secret boundary, shared RAG, worktrees, replay и telemetry.
- [Server Runtime V2](server-runtime-v2.md) — предыдущий фундамент task/control runtime и история перехода к V3.
- [Permission control plane](control-plane.md) — R0–R4 risk policy, auto-approval безопасных действий, project rules и audit.
- [Модели и routing](models-and-routing.md) — Build/Plan, model-selected orchestration, Qwen profiles, provider paths и стоимость.
- [Интеграция RAG](rag.md) — `mcp-rag`, lifecycle и server-managed retrieval.
- [`/rag-start`](rag-start.md) — запуск/проверка RAG из web-клиента без LLM-токенов.
- [Doctor](doctor.md) — бесплатные health checks и ручные платные E2E smoke tests.
- [Эксплуатация и recovery](operations.md) — systemd, обновление, backup, логи, восстановление и проверка после upgrade.
- [Troubleshooting](troubleshooting.md) — типовые симптомы и порядок диагностики.

## Репозитории

Система разделена на два проекта:

- `custom_opencode` — UI, OpenCode V2 config, server runtime, модели/profiles, agents, MCP gateway/wiring, installer, self-test и lifecycle-control;
- `mcp-rag` — локальная инженерная база знаний: registry, Qdrant, embeddings/BM25/reranker, ingestion и knowledge tools.

`custom_opencode` может работать без `mcp-rag`. Если RAG не найден или явно отключён, installer отключает `kb`, а обычные OpenCode/model workflows остаются рабочими.

## Базовая схема

```text
Browser / PWA / CLI
    |
    v
OpenCode V2 + custom server control plane
    |
    +--> Server Runtime V3
    |       +--> SQLite/WAL tasks / dependencies / checkpoints / events
    |       +--> capability registry + model profiles + adaptive router
    |       +--> native context compaction + bounded context planner
    |       +--> AST/symbol/embedding/dependency/git repo index
    |       +--> semantic symbol diff + shared context/tool caches
    |       +--> MCP Code Mode gateway + health/rate/policy layer
    |       +--> scoped secrets + enforced sandbox/worktrees/ownership
    |       +--> artifacts / mailbox / typed handoff / verification / review
    |       +--> shared engineering RAG / memory / decision log
    |       +--> branching / replay / telemetry / remote notification API
    |       +--> Task Center + Runtime control-plane dashboard
    |
    +--> permission control plane (R0-R4)
    |
    +--> OpenCode V2 native model/tool/session engine
            |
            +--> Build / Plan
            +--> direct selected model
            +--> qwen3.8-coder / orchestrated / review / fast profiles
            +--> MCP Code Mode namespaces
            +--> optional mcp-rag knowledge source
```

## Основной принцип безопасности

Permission control plane остаётся детерминированным и не делегирует модели право понижать собственный risk floor. R3/R4 сохраняют интерактивную границу.

Runtime V3 добавляет ещё один слой: OpenCode V2 plugin hooks выполняют server-side sandbox/ownership/loop/rate policy до tool execution, shell environment очищается от server secret prefixes, а большие результаты после execution уходят в ArtifactStore. `safe`, `repo-write`, Docker/WSL и gated `full-machine` — реальные execution policies, а не UI labels.

Provider credentials по-прежнему обязаны существовать внутри доверенной server/OpenCode service boundary, но не сериализуются в browser/runtime snapshots и удаляются из agent-created shell environments. Для явной передачи секретов используется scoped broker allowlist.

RAG и локальные модели остаются необязательными. Падение Qdrant, отсутствие Ollama или ошибка retrieval не должны блокировать обычную работу OpenCode: auto profiles переходят на доступный cloud path, а direct profile сохраняет вручную выбранную модель.
