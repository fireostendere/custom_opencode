# `/rag-start`

`/rag-start` — локальная control-команда web client. Она перехватывается до отправки prompt в OpenCode model runtime и сама по себе не расходует Qwen/OpenAI tokens.

Команда нужна для управляемого запуска/проверки RAG на конкретной машине и для переподключения RAG MCP текущего OpenCode workspace: глобального `kb` или проектного (`<name>_kb`, например `engineering_kb`, `cossacks_kb`, или `dnd`), который добавляет проектный конфиг или плагин.

## Режимы

### Полный

```text
/rag-start
/rag-start full
```

Последовательность:

1. получить выбранный `sessionID` из UI;
2. server-side запросить у OpenCode directory этой session — arbitrary filesystem path от browser не принимается;
3. найти в этом workspace включённые RAG MCP servers (`kb`, `*_kb`, `dnd`); если их нет — сразу вернуть `stage: workspace`, ничего не запуская;
4. обнаружить `mcp-rag` через `MCP_RAG_ROOT`, adjacent `../mcp-rag` или `~/mcp-rag`;
5. выполнить model-free quick preflight через `knowledge_base.runtime`;
6. проверить Qdrant;
7. если local loopback Qdrant остановлен — разрешено поднять только фиксированный Compose service `qdrant`;
8. проверить непустой registry/corpus и существование Qdrant collection;
9. только после успешного preflight сделать один локальный retrieval smoke (`DipTrace PCB layout`);
10. `POST /api/mcp/<server>/connect` для каждого найденного, но не connected RAG server этого workspace (новых серверов не добавляет);
11. дождаться `connected` в bounded window;
12. independent MCP probe: initialization, `list_tools`, `knowledge_status`;
13. проверить required tools.

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
- reconnect RAG MCP servers этого workspace;
- MCP protocol/tools;

Это режим, который используется post-install self-test.

## Idempotence

Повторный вызов не должен создавать несколько Qdrant containers или несколько параллельных startup attempts.

Server использует mutex: одновременно выполняется одна RAG start/check операция.

Если Qdrant уже работает, bootstrap возвращает `already-running` и ничего не перезапускает.

Если RAG server уже connected, повторный connect не нужен.

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
- зацикливаться на бесконечных retries;
- добавлять MCP server в workspace (`PUT /api/mcp/...`) или менять runtime config: где RAG нужен, его объявляет проектный конфиг/плагин.

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
- OpenCode MCP connect ограничен;
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
