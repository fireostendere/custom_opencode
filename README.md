# custom_opencode

Переносимый комплект поверх OpenCode V2: собственный ChatGPT-подобный web/PWA client, Alibaba/Qwen routing, безопасная работа с локальными проектами, диагностика/self-test и опциональный инженерный RAG через MCP.

## Что предоставляет

- web/PWA UI для OpenCode sessions;
- isolated quick-session workspaces;
- `Проекты → Папки на ПК` с filesystem allowlist и symlink containment;
- Build/Plan, model/provider/effort controls;
- отдельную группу бесплатных моделей без mobile keyboard search field;
- native slash commands;
- Markdown/code/tool/reasoning renderers;
- files и clipboard images;
- Git/VCS UI, fork/duplicate/handoff, notifications, drafts;
- Qwen Token Plan и Codex rate-limit sidebar;
- cloud routing `Qwen 3.8 Max → Qwen 3.6 Flash fast-reader`;
- manual-only local Ollama models;
- optional `mcp-rag` integration через `kb` MCP;
- `/rag-start` и `/doctor`;
- pre-install verifier и post-install zero-LLM-token self-test;
- user systemd deployment и one-command update.

## Routing по умолчанию

```text
Primary:     bailian-cli/qwen3.8-max
Read worker: fast-reader → bailian-cli/qwen3.6-flash
Title:       bailian-cli/qwen3.6-flash
Local:       ollama/* — только ручной выбор
```

`fast-reader` — bounded read-only worker для repository exploration, логов и точечного RAG lookup. Он не получает edit/shell права. Финальные решения остаются у primary model.

Отдельный UI switch `Router/Direct` в текущей реализации отсутствует: router-like behavior работает через `build/plan` + разрешённый `fast-reader`.

## RAG

RAG полностью опционален. Если `mcp-rag` не найден, installer создаёт рабочий OpenCode config с `kb.disabled=true`.

Когда RAG установлен, `/rag-start` может без LLM-токенов проверить/поднять локальный Qdrant, проверить corpus/index, подключить `kb` к текущему workspace и проверить MCP tools.

Поиск по уже проиндексированному corpus выполняется локально: Qdrant + FastEmbed + BM25 + optional reranker.

## Быстрый старт

Требуются OpenCode V2, Python 3, Node.js и `systemd --user`.

```bash
cp .env.example .env
# заполнить .env
./scripts/verify.sh
./scripts/install.sh
```

После установки:

```bash
custom-opencode
```

Обновление:

```bash
custom-opencode-update
```

Installer по умолчанию выполняет pre-install verification и post-install runtime self-test. Платный model inference автоматически не запускается.

## Документация

Полный индекс: [`docs/README.md`](docs/README.md).

Основные разделы:

- [Установка, миграция и обновление](docs/installation.md)
- [Конфигурация `.env`](docs/configuration.md)
- [Архитектура и возможности](docs/architecture.md)
- [Модели и routing](docs/models-and-routing.md)
- [RAG integration](docs/rag.md)
- [`/rag-start`](docs/rag-start.md)
- [Doctor](docs/doctor.md)
- [Эксплуатация и recovery](docs/operations.md)
- [Troubleshooting](docs/troubleshooting.md)

Отдельная документация по созданию/индексации corpus находится в репозитории `mcp-rag`.

## Структура

```text
app/       web client + authenticated proxy + Doctor/RAG lifecycle
config/    OpenCode V2 providers, agents, prompts, plugins
scripts/   verify/install/update/RAG probes
systemd/   user service
 docs/     пользовательская и эксплуатационная документация
```

## Security defaults

- secrets и host-specific URLs — только в `.env`;
- web UI использует Basic Auth;
- рекомендуемый bind — loopback;
- project browser ограничен `OPENCODE_PROJECT_ROOTS`;
- quick workspace cleanup защищён containment checks;
- automatic Ollama отключён;
- RAG ingest не разрешён read-only worker;
- MCP execution timeout ограничен;
- install/update завершается ошибкой, если critical host self-test не прошёл.

OpenCode V2 остаётся изменяющимся upstream, поэтому verifier и host-level Doctor являются частью штатной эксплуатации, а не только development tooling.
