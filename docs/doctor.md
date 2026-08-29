# Doctor / Диагностика

Doctor — встроенная host-level диагностика `custom_opencode`. Панель открывается кнопкой `Диагностика` или локальной командой:

```text
/doctor
```

Открытие Doctor само по себе не создаёт model prompt и не расходует LLM-токены.

## Зачем он нужен

Статически правильный JSON ещё не доказывает, что конкретная машина действительно имеет:

- живой OpenCode backend;
- доступный provider catalog;
- рабочий Bailian Token Plan auth;
- подключённый MCP;
- живой Qdrant/corpus;
- реально зарегистрированные RAG tools.

Doctor проверяет эти слои отдельно, чтобы ошибка не маскировалась зелёным статусом соседнего компонента.

## Бесплатные checks

При открытии панели проверяются:

- OpenCode backend HTTP availability;
- rendered runtime `opencode.json`;
- наличие `bailian-cli/qwen3.8-max` и `bailian-cli/qwen3.6-flash` в model catalog;
- Bailian Token Plan usage/auth через `bl usage token-plan --output json`;
- routing config: Max primary, Flash `fast-reader`, отсутствие automatic `ollama/*` agents;
- OpenCode MCP status для `kb`;
- обнаружение локального RAG executable;
- independent MCP protocol initialization + `list_tools`;
- required RAG tools: `knowledge_search`, `knowledge_get`, `knowledge_sources`, `knowledge_status`;
- `knowledge_status`: Qdrant/corpus/lifecycle settings.

Independent MCP probe сделан намеренно: `kb: connected` подтверждает transport, но не гарантирует, что ожидаемые tools действительно discover/call-ятся.

## Smoke tests

Doctor не запускает платные smoke автоматически. Перед model-backed проверкой требуется явное подтверждение, одновременно выполняется только один smoke.

### RAG retrieval — 0 LLM tokens

Создаёт временный MCP client и выполняет один `knowledge_search(top_k=1)`.

Использует локальный embedding/reranker compute, но не Qwen/OpenAI API.

### Qwen Flash inference — платно

Создаёт временную scratch session и делает один короткий запрос к `qwen3.6-flash`, затем очищает session/workspace.

### Qwen Max inference — платно

То же для `qwen3.8-max`.

### Router E2E — платно

Max получает bounded задачу, которую должен делегировать `fast-reader`. Doctor проверяет:

- child session создана;
- child model — `qwen3.6-flash`;
- ожидаемый random marker получен;
- в child trace нет Ollama.

### Router + RAG E2E — платно

Дополнительно проверяется фактический вызов `kb_knowledge_search` внутри delegated path.

## Cleanup smoke tests

Temporary smoke workspaces создаются под isolated quick-session root. Parent/child sessions удаляются после проверки; scratch cleanup использует тот же containment guard, что и обычные quick sessions.

Browser сохраняет только последний статус/timestamp smoke в `localStorage`, без credentials и prompt payloads.

## Как читать ошибки

| Состояние | Наиболее вероятный слой |
|---|---|
| Catalog PASS, inference FAIL | provider auth/runtime/model request |
| `kb` disabled/FAIL, direct MCP probe PASS | OpenCode MCP wiring/workspace connect |
| `kb` connected, direct MCP probe FAIL | RAG executable/venv/protocol environment |
| Qdrant FAIL | RAG backend; обычный OpenCode должен продолжить работу |
| RAG retrieval PASS, Router+RAG FAIL | delegation/RAG handoff policy |
| Max/Flash inference PASS, Router E2E FAIL | subagent/delegation path |

## Рекомендуемый порядок диагностики

Сначала бесплатные checks:

```text
1. открыть /doctor
2. /rag-start quick
3. /rag-start
4. Doctor → RAG retrieval
```

Только если нужно доказать provider execution/routing:

```text
5. Flash inference
6. Max inference
7. Router E2E
8. Router + RAG E2E
```

## Install self-test и Doctor

Install self-test проверяет критический минимум автоматически после install/update: service, backend, web HTTP и, если RAG настроен, `rag-start quick`-эквивалент.

Doctor шире: он даёт detailed snapshot и ручные E2E проверки.

GitHub CI не заменяет Doctor, потому что local auth, OpenCode process, Qdrant corpus и RAG venv существуют только на конкретном host.
