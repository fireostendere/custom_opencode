# Документация custom_opencode

`custom_opencode` — переносимый комплект поверх OpenCode V2: web/PWA-интерфейс, Alibaba/Qwen routing, безопасное открытие локальных проектов, диагностика, self-test и опциональный инженерный RAG через MCP.

## С чего начать

- [Установка и обновление](installation.md) — новая установка, миграция существующей установки, self-test, systemd и обновления.
- [Конфигурация `.env`](configuration.md) — все основные переменные окружения, секреты, пути и рекомендуемые значения.
- [Архитектура и возможности](architecture.md) — из каких компонентов состоит система и что именно она предоставляет.
- [Модели и routing](models-and-routing.md) — Build/Plan, model-selected orchestration, Qwen Max → Flash, ручной Ollama, permissions и стоимость.
- [Интеграция RAG](rag.md) — что нужно для RAG, как `custom_opencode` связывается с `mcp-rag`, lifecycle и ограничения.
- [`/rag-start`](rag-start.md) — запуск/проверка RAG из web-клиента без LLM-токенов.
- [Doctor](doctor.md) — бесплатные health checks и ручные платные E2E smoke tests.
- [Эксплуатация и recovery](operations.md) — systemd, обновление, backup, логи, восстановление и проверка после upgrade.
- [Troubleshooting](troubleshooting.md) — типовые симптомы и порядок диагностики.

## Репозитории

Система разделена на два проекта:

- `custom_opencode` — UI, OpenCode V2 config, модели, agents, MCP wiring, installer, self-test и lifecycle-control;
- `mcp-rag` — локальная инженерная база знаний: Qdrant, FastEmbed, BM25, reranker, ingestion и MCP tools.

`custom_opencode` может работать без `mcp-rag`. Если RAG не найден или явно отключён, installer рендерит `kb.disabled=true`, а обычные OpenCode/model workflows остаются рабочими.

## Базовая схема

```text
Browser / PWA
    |
    v
custom_opencode web proxy
    |
    +--> OpenCode V2 backend
    |       |
    |       +--> Build / Plan user modes
    |       +--> ordinary selected models (direct execution)
    |       +--> Qwen 3.8 Max · Оркестрированная
    |               |
    |               +--> Qwen 3.6 Flash (fast-reader)
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

RAG, локальные модели и дополнительные интеграции не должны становиться обязательным control-plane. Падение Qdrant, отсутствие Ollama или ошибка retrieval должны деградировать качество/доступность конкретной функции, но не блокировать обычную работу OpenCode.
