# custom_opencode

Переносимый комплект поверх OpenCode V2: собственный ChatGPT-подобный web/PWA client, Alibaba/Qwen routing, безопасная работа с локальными проектами, диагностика/self-test и опциональный инженерный RAG через MCP.

## Что предоставляет

- web/PWA UI для OpenCode sessions;
- isolated quick-session workspaces;
- `Проекты → Папки на ПК` с filesystem allowlist и symlink containment;
- только два пользовательских режима работы: `Direct` и `Plan`;
- model picker с избранным, сортировкой, сворачиваемыми провайдерами и отдельной группой бесплатных моделей;
- отдельный вариант `Qwen 3.8 Max · Оркестратор` прямо в model picker;
- автоматическую очередь сообщений без ручного `Steer/Queue` переключателя;
- одну контекстную кнопку composer: send / stop / queue;
- компактные permission cards с деталями под раскрытием;
- native slash commands;
- Markdown/code/tool/reasoning renderers;
- files и clipboard images;
- Git/VCS UI, fork/duplicate/handoff, notifications, drafts;
- Qwen Token Plan и Codex rate-limit sidebar;
- orchestration `Qwen 3.8 Max → Qwen 3.6 Flash fast-reader`;
- manual-only local Ollama models;
- optional `mcp-rag` integration через `kb` MCP;
- `/rag-start` и `/doctor`;
- pre-install verifier и post-install zero-LLM-token self-test;
- user systemd deployment и one-command update.

## Direct / Plan и orchestration

`Direct` и `Plan` — единственные пользовательские режимы выполнения:

- `Direct` — модель может выполнять обычную рабочую задачу с доступными ей edit/shell permissions;
- `Plan` — read/plan-only режим без edit и shell.

Оркестрация не является отдельным режимом. Она выбирается только через специальную модель в picker:

```text
Direct | Plan
     +
Qwen 3.8 Max · Оркестратор
        ↓ при необходимости
fast-reader → Qwen 3.6 Flash
        ↓ при corpus-relevant engineering lookup
kb MCP → mcp-rag
```

Любая обычная модель из picker работает напрямую. `Qwen 3.8 Max · Оркестратор` использует тот же Qwen Max как primary, но разрешает bounded delegation в `fast-reader` и optional RAG.

Внутренние OpenCode agent IDs `build`, `plan`, `build-direct`, `plan-direct` являются implementation detail и не должны отображаться как дополнительные пользовательские режимы.

`fast-reader` — bounded read-only worker для repository exploration, логов и точечного RAG lookup. Он не получает edit/shell права. Финальные решения остаются у Qwen 3.8 Max.

Локальный `ollama/*` остаётся только ручным direct model choice и не включается в automatic path.

## Composer

Отдельного `Steer / Queue` переключателя в UI нет.

Поведение выбирается автоматически:

```text
работы нет                         → ↑ Отправить
работа идёт + composer пустой      → × Остановить
работа идёт + есть текст/вложение  → ↑ Добавить в очередь
```

Очередь хранится для конкретной session и отправляется после завершения текущей работы.

## RAG

RAG полностью опционален. Если `mcp-rag` не найден или явно отключён через `MCP_RAG_ENABLED=0`, installer создаёт рабочий OpenCode config с `kb.disabled=true`.

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
docs/      пользовательская и эксплуатационная документация
```

## Security defaults

- secrets и host-specific URLs — только в `.env`;
- web UI использует Basic Auth;
- рекомендуемый bind — loopback;
- project browser ограничен `OPENCODE_PROJECT_ROOTS`;
- quick workspace cleanup защищён containment checks;
- automatic Ollama отключён;
- обычные модели не получают automatic RAG/subagent delegation;
- RAG ingest не разрешён read-only worker;
- MCP execution timeout ограничен;
- install/update завершается ошибкой, если critical host self-test не прошёл.

OpenCode V2 остаётся изменяющимся upstream, поэтому verifier и host-level Doctor являются частью штатной эксплуатации, а не только development tooling.
