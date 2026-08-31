# Интеграция RAG

## Что даёт RAG

RAG добавляет локальный инженерный источник evidence для задач, где обычной model memory недостаточно или нужен точный reference.

Типовые источники:

- datasheet;
- application notes;
- reference designs;
- PCB/layout guides;
- официальная документация DipTrace;
- инженерные статьи;
- YouTube transcripts/конспекты;
- другие документы, которые явно добавлены в `mcp-rag` corpus.

Поиск по уже проиндексированному корпусу не требует внешнего LLM API: Qdrant, embeddings, BM25 и reranker работают локально.

## Что нужно для RAG

На host должны быть:

- checkout `mcp-rag`;
- Python >= 3.10;
- virtualenv `.venv`;
- установленный package `knowledge-base-rag`;
- `.venv/bin/knowledge-mcp`;
- Docker + Compose;
- локальный Qdrant;
- непустой corpus/SQLite registry;
- существующая совместимая Qdrant collection/index;
- локально доступные FastEmbed models при первом retrieval.

Минимальная установка RAG описана в `mcp-rag/docs/installation.md`.

## Как custom_opencode находит RAG

Installer использует:

1. `MCP_RAG_ROOT`;
2. соседний `../mcp-rag`;
3. `~/mcp-rag`.

Executable:

- явно `MCP_RAG_BIN`;
- иначе `<RAG_ROOT>/.venv/bin/knowledge-mcp`.

Если executable не найден, runtime config получает:

```json
"disabled": true
```

Это нормальный режим: OpenCode работает без RAG.

## MCP server

В runtime config RAG представлен как server `kb`:

```text
OpenCode V2
  └── kb local stdio MCP
        └── scripts/rag-mcp.sh
              └── mcp-rag/.venv/bin/knowledge-mcp
```

OpenCode остаётся supervisor stdio MCP process. `custom_opencode` не запускает второй постоянный `knowledge-mcp` daemon.

Timeouts ограничены:

```text
startup:   10 s
catalog:   10 s
execution: 60 s
```

Это защищает session от многоминутного зависания MCP call.

## MCP tools

Read-only worker может использовать:

- `kb_knowledge_search`;
- `kb_knowledge_get`;
- `kb_knowledge_sources`;
- `kb_knowledge_status`.

`kb_knowledge_ingest` не разрешён `fast-reader`. На global level mutation остаётся permission-gated (`ask`).

## Когда RAG должен использоваться

Хорошие случаи:

- «какие layout рекомендации у этого PMIC?»;
- «что DipTrace говорит про differential pair?»;
- «найди в проиндексированном видео этап настройки X»;
- «сверь решение с datasheet».

Плохие случаи:

- простой coding question, ответ на который есть в repository;
- обычная арифметика;
- generic knowledge;
- задача, для которой corpus заведомо ничего не содержит.

RAG — optional evidence service, не обязательный gateway каждого prompt.

## Lifecycle тяжёлых моделей

MCP process остаётся доступным для discovery, но embedding/reranker загружаются только на операциях, которым они нужны.

`knowledge_status`/`knowledge_get` не должны без причины загружать embedding model.

После `KB_MODEL_IDLE_SECONDS` модельные ресурсы освобождаются. Default в `mcp-rag` — 600 секунд.

Первый retrieval после unload может быть медленнее из-за повторной загрузки ONNX models.

## `/rag-start`

`/rag-start` — локальная control-команда web UI. Она не отправляется LLM.

Полный режим:

```text
/rag-start
```

делает:

1. quick infrastructure preflight;
2. при необходимости безопасно стартует только loopback Qdrant service;
3. проверяет corpus и существование collection;
4. делает локальный retrieval smoke;
5. определяет текущий OpenCode workspace через sessionID;
6. подключает `kb` именно к этому workspace;
7. проверяет required MCP tools;
8. после успешного live connect атомарно сохраняет `kb.disabled=false`;

Быстрый режим:

```text
/rag-start quick
```

не делает embedding/reranker retrieval, но проверяет инфраструктуру и MCP connection.

Подробнее: [rag-start.md](rag-start.md).

## Поведение при повреждении/отсутствии индекса

Health/start path не должен автоматически выполнять ingest/rebuild.

Если SQLite registry говорит, что corpus существует, но Qdrant collection отсутствует, это ошибка состояния. Нужно выполнить осознанный rebuild по процедуре `mcp-rag`, а не создавать пустую collection во время health check.

Запрещённые recovery-shortcuts:

```text
docker compose down -v
автоматический ingest-all при каждом старте
тихий recreation collection
```

## Fail-open для основной работы

Если RAG недоступен:

- обычные model prompts должны продолжать работать;
- repository tools должны продолжать работать;
- caller не должен делать бесконечные retry;
- RAG error должен быть видимым evidence-gap, а не причиной зависания всей задачи.

## Проверка

Самый дешёвый порядок:

```text
1. install self-test     — 0 LLM tokens
2. /rag-start quick      — 0 LLM tokens
3. /rag-start            — 0 LLM tokens, локальный embedding/reranker
4. Router + RAG E2E      — только вручную, платный inference
```

Если первые три проходят, сама RAG инфраструктура доказана без расхода provider tokens.
