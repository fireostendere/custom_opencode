# `/rag-start`

`/rag-start` — локальная control-команда web client. Она перехватывается до отправки prompt в OpenCode model runtime и сама по себе не расходует Qwen/OpenAI tokens.

Команда нужна для управляемого запуска/проверки RAG на конкретной машине и для подключения `kb` к текущему OpenCode workspace.

## Режимы

### Полный

```text
/rag-start
/rag-start full
```

Последовательность:

1. обнаружить `mcp-rag` через `MCP_RAG_ROOT`, adjacent `../mcp-rag` или `~/mcp-rag`;
2. выполнить model-free quick preflight через `knowledge_base.runtime`;
3. проверить Qdrant;
4. если local loopback Qdrant остановлен — разрешено поднять только фиксированный Compose service `qdrant`;
5. проверить непустой registry/corpus и существование Qdrant collection;
6. только после успешного preflight сделать один локальный retrieval smoke (`DipTrace PCB layout`);
7. получить выбранный `sessionID` из UI;
8. server-side запросить у OpenCode directory этой session — arbitrary filesystem path от browser не принимается;
9. dynamic add/connect `kb` через OpenCode V2 MCP API именно для выбранного workspace;
10. дождаться `connected` в bounded window;
11. independent MCP probe: initialization, `list_tools`, `knowledge_status`;
12. проверить required tools;
13. только после успешного live connection атомарно сохранить `mcp.servers.kb.disabled=false` в runtime config;

Full mode использует локальный embedding/reranker для smoke retrieval, но не внешний LLM API.

### Быстрый

```text
/rag-start quick
```

Quick mode пропускает embedding/reranker retrieval smoke.

Он всё равно проверяет:

- наличие RAG runtime;
- Qdrant readiness/start;
- registry/corpus;
- collection;
- current workspace;
- dynamic `kb` connection;
- MCP protocol/tools;
- persisted enablement после успешного connect.

Это режим, который используется post-install self-test.

## Idempotence

Повторный вызов не должен создавать несколько Qdrant containers или несколько параллельных startup attempts.

Server использует mutex: одновременно выполняется одна RAG start/check операция.

Если Qdrant уже работает, bootstrap возвращает `already-running` и ничего не перезапускает.

Если `kb` уже connected, повторный connect не нужен.

## Что команда никогда не делает

`/rag-start` не должен:

- запускать remote Qdrant;
- выполнять arbitrary shell string из browser;
- запускать произвольный Docker service;
- делать `ingest-all`;
- делать rebuild/reindex;
- удалять Qdrant volume;
- создавать пустую collection при потерянном индексе;
- запускать второй standalone `knowledge-mcp` daemon;
- принимать browser-provided raw project directory;
- зацикливаться на бесконечных retries.

## Runtime ownership

OpenCode остаётся supervisor stdio server:

```text
OpenCode
  └── kb
       └── bash scripts/rag-mcp.sh
            └── mcp-rag/.venv/bin/knowledge-mcp
```

`/rag-start` управляет readiness backing infrastructure и MCP connection state, но не подменяет OpenCode process supervision.

## Missing collection

Если registry содержит corpus, но Qdrant collection отсутствует, состояние считается broken/not-ready.

Health path должен сообщить explicit rebuild-required error. Он не создаёт новую пустую collection и не маскирует потерю vector index.

Rebuild выполняется отдельно по процедуре `mcp-rag`.

## Timeouts

Lifecycle bounded на нескольких уровнях:

- Docker Compose invocation ограничен;
- Qdrant startup wait ограничен;
- OpenCode MCP add/connect ограничен;
- polling `connected` ограничен;
- MCP execution config ограничен 60 секундами.

Если слой не стал ready в отведённое время, команда возвращает structured failure.

## Где смотреть результат

При успехе UI показывает краткий статус вида:

```text
RAG готов · <documents> docs · <chunks> chunks · <points> points · MCP connected
```

После выполнения UI показывает краткий результат RAG-проверки и подключения MCP.

## Проверка без UI

В `mcp-rag`:

```bash
.venv/bin/python -m knowledge_base.runtime --json --no-start
```

Проверка с разрешённым стартом local Qdrant:

```bash
.venv/bin/python -m knowledge_base.runtime --json
```

Полный локальный retrieval smoke:

```bash
.venv/bin/python -m knowledge_base.runtime --json --search "DipTrace PCB layout"
```

Эти команды не подключают MCP к OpenCode workspace — это делает именно `/rag-start`/`server_rag.py`.
