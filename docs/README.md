# Документация custom_opencode

`custom_opencode` — переносимый комплект поверх OpenCode V2: web/PWA-интерфейс, Alibaba/Qwen routing, безопасное открытие локальных проектов, диагностика, self-test, серверный task/control runtime и опциональный инженерный RAG через MCP.

## С чего начать

- [Установка и обновление](installation.md) — новая установка, миграция существующей установки, self-test, systemd и обновления.
- [Конфигурация `.env`](configuration.md) — все основные переменные окружения, секреты, пути и рекомендуемые значения.
- [Архитектура и возможности](architecture.md) — из каких компонентов состоит система и что именно она предоставляет.
- [Server Runtime V2](server-runtime-v2.md) — durable tasks, model profiles, scheduler, checkpoints, repo/context services, Task Center и точные границы текущей реализации.
- [Permission control plane](control-plane.md) — R0–R4 risk policy, auto-approval безопасных действий, project rules и audit.
- [Модели и routing](models-and-routing.md) — Build/Plan, model-selected orchestration, Qwen Max → Flash, ручной Ollama, permissions и стоимость.
- [Интеграция RAG](rag.md) — что нужно для RAG, как `custom_opencode` связывается с `mcp-rag`, lifecycle и ограничения.
- [`/rag-start`](rag-start.md) — запуск/проверка RAG из web-клиента без LLM-токенов.
- [Doctor](doctor.md) — бесплатные health checks и ручные платные E2E smoke tests.
- [Эксплуатация и recovery](operations.md) — systemd, обновление, backup, логи, восстановление и проверка после upgrade.
- [Troubleshooting](troubleshooting.md) — типовые симптомы и порядок диагностики.

## Репозитории

Система разделена на два проекта:

- `custom_opencode` — UI, OpenCode V2 config, server runtime, модели, agents, MCP wiring, installer, self-test и lifecycle-control;
- `mcp-rag` — локальная инженерная база знаний: Qdrant, FastEmbed, BM25, reranker, ingestion и MCP tools.

`custom_opencode` может работать без `mcp-rag`. Если RAG не найден или явно отключён, installer рендерит `kb.disabled=true`, а обычные OpenCode/model workflows остаются рабочими.

## Базовая схема

```text
Browser / PWA
    |
    v
custom_opencode web proxy
    |
    +--> Server Runtime V2
    |       +--> SQLite tasks / checkpoints / events / usage
    |       +--> model capability registry + profiles
    |       +--> resource scheduler
    |       +--> repo/context/artifact/verification services
    |       +--> Task Center API/UI
    |
    +--> permission control plane (R0-R4)
    |
    +--> OpenCode V2 backend
    |       |
    |       +--> Build / Plan user modes
    |       +--> ordinary selected models (direct execution)
    |       +--> Qwen 3.8 server profiles
    |               |
    |               +--> Qwen 3.6 Flash fast path / researchers
    |               +--> kb MCP when useful
    |
    +--> Doctor / provider-limit bridges
    |
    +--> kb MCP (optional)
            |
            v
         mcp-rag
            |
            +--> SQLite registry
            +--> Qdrant
            +--> FastEmbed embedding/reranker
```

## Основной принцип безопасности

Permission control plane детерминирован и не делегирует модели оценку собственной безопасности. R3/R4 остаются интерактивными даже при project `allow`.

Server Runtime V2 не отменяет эти границы: sandbox profile сейчас является intent/metadata, а не заменой permission enforcement. Secret Broker пока foundation и не должен трактоваться как доказательство того, что все существующие provider/MCP credentials уже проходят через него.

RAG, локальные модели и дополнительные интеграции не должны становиться обязательным model-routing control-plane. Падение Qdrant, отсутствие Ollama или ошибка retrieval должны деградировать качество/доступность конкретной функции, но не блокировать обычную работу OpenCode.
