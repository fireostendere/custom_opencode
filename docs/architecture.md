# Архитектура и возможности

## Что такое custom_opencode

`custom_opencode` не является форком OpenCode. Это host-side комплект вокруг OpenCode V2, который добавляет собственный web/PWA client, переносимую конфигурацию, persistent workflow state, диагностику, безопасный browser локальных проектов и опциональную связь с `mcp-rag`.

OpenCode остаётся execution/model backend; `custom_opencode` управляет UX и host integration.

## Компоненты

### OpenCode V2 backend

Отвечает за sessions, agents/subagents, model/provider execution, permissions, native questions/commands, MCP supervision и Git/VCS/session APIs.

### Web/PWA client

Каталог `app/` предоставляет:

- root sessions в sidebar, child sessions только в orchestration trace;
- isolated quick workspaces;
- parallel running states;
- automatic send / cancel / persistent queue;
- только `Build / Plan` как execution modes;
- direct/orchestrated model profiles;
- native question cards с single/multi-select и custom answer;
- project memory/defaults/permission policy;
- compact permission cards;
- advanced Changes/Review с file/hunk revert;
- orchestration tree;
- model/context/cost/runtime/RAG/queue status bar;
- files/images, Markdown/code/tool/reasoning rendering;
- drafts, deep links и actionable PWA notifications;
- provider quotas, Doctor, `/rag-start`, project browser.

Локальные Ollama models остаются manual-only ordinary model entries существующего model picker. Новый workflow layer не реализует local/cloud router и не управляет local runtime.

### Server layers

```text
server.py
  └── server_ext.py
        └── server_plus.py
              ├── server_rag.py
              └── server_features.py
                    ↓ composed by
                server_workflow.py
```

`server.py` — Basic Auth, same-origin proxy, quick-session isolation, scratch cleanup.

`server_ext.py` — provider-limit bridges.

`server_plus.py` — constrained host-directory browser, symlink containment, Doctor endpoints.

`server_rag.py` — `/rag-start`, MCP workspace routing, dynamic `kb` connect и persisted RAG enablement.

`server_features.py` — persistent queue/project settings, project permission rules, safe Git revert и background queue worker.

`server_workflow.py` — production entrypoint. Он композиционно сохраняет RAG routes, добавляет workflow send path и отправку project memory через OpenCode `system` context.

Systemd запускает `app/server_workflow.py`.

## Persistent workflow state

По умолчанию state находится в:

```text
$XDG_STATE_HOME/custom-opencode/web-features.json
```

или `~/.local/state/custom-opencode/web-features.json`.

Файл создаётся с user-only permissions и содержит только workflow metadata: queued prompts/attachments, project preferences и permission rules. Secrets туда не записываются.

Queue worker живёт внутри production web process. Он может дождаться завершения run и отправить следующий queued prompt, даже если браузер/PWA закрыт.

## Quick sessions и project boundary

Quick session создаётся в отдельном `<scratch>/session-<random>/`. Cleanup разрешён только после containment check.

Project browser и workflow endpoints используют canonicalized path и `OPENCODE_PROJECT_ROOTS`. Symlink/path traversal за allowlist не допускается.

Git revert дополнительно проверяет целевой relative path и для hunk принимает только patch, заголовки которого относятся к выбранному файлу.

## Build / Plan и model profiles

Пользовательский execution mode всегда один из:

```text
Build | Plan
```

Model picker отдельно выбирает execution profile:

```text
обычная модель                    → direct
Qwen 3.8 Max · Оркестрированная   → bounded subagent/RAG delegation
```

Внутренняя agent matrix:

```text
обычная модель + Build         → build-direct
обычная модель + Plan          → plan-direct
Оркестрированная + Build       → build
Оркестрированная + Plan        → plan
```

Agent IDs не показываются пользователю.

Локальный provider остаётся ordinary direct model choice только при реальном ручном выборе пользователя. Project defaults, persistent queue и workflow worker не имеют automatic `ollama/*` route.

## Composer и queue

```text
нет active run                  → send
active run + empty composer     → cancel
active run + text/attachment    → persistent queue
```

Скрытые native controls остаются compatibility layer, но пользователь не выбирает `Steer/Queue` вручную.

Advanced frontend перехватывает queued submit и отправляет его в `/client-queue.json`; сервер хранит порядок и удаляет item только после успешного принятия backend.

Queue worker отправляет prompt с уже выбранным model/provider текущей session. Он не переключает model и не выполняет model lifecycle actions.

## Native questions

OpenCode question request не преобразуется в обычный текст. Web UI получает pending native request и показывает:

- header/question;
- option labels/descriptions;
- single или multiple selection;
- собственный текстовый вариант;
- несколько вопросов в одном request.

Reply отправляется native question endpoint как `answers: string[][]`, после чего agent loop продолжает работу.

## Project memory и defaults

Project settings привязаны к canonical directory. Persistent instructions при submit передаются отдельным `system` field current OpenCode message API, поэтому не отображаются как часть user message.

Также проект может задать default mode, orchestrated/конкретную cloud model, RAG preference и permission rules.

`auto` и `ollama/*` не принимаются как автоматические project defaults. Старые experimental значения sanitizes в `inherit`. Это не влияет на ручной выбор Ollama в model picker.

Defaults применяются только к пустой/new session, чтобы открытие существующей session не меняло её execution state неожиданно.

## Permissions

Permission banner показывает короткий summary; raw payload остаётся под details.

Project policy имеет ordered rules:

```text
action glob + resource glob → ask | allow | deny
```

`Разрешать в проекте` создаёт конкретное allow-rule из текущего native permission request. Background worker может автоматически ответить только на явно сохранённые `allow/deny`; остальные requests остаются интерактивными.

## Changes / Review

Базовый Git/VCS drawer остаётся источником статуса. Review layer строит file/hunk representation поверх session/VCS diff и даёт bounded revert:

- tracked file: `git restore --worktree -- <path>`;
- untracked: удаляется только выбранный contained file;
- hunk: reverse `git apply` после проверки file headers.

## Orchestration trace

Child/subagent sessions намеренно не возвращаются в sidebar. Текущая root session показывает раскрываемый trace с primary + child nodes, model/agent/status/runtime и RAG marker при использовании knowledge tools.

## RAG

`kb` — optional local MCP server. Automatic retrieval разрешён только orchestrated profile; ordinary direct agents сохраняют deny rules на subagent/RAG delegation.

Подробнее: [rag.md](rag.md).

## Installer / verifier

Deployment gate:

```text
verify source/contracts
       ↓
render/install config
       ↓
restart services
       ↓
real host self-test
```

Zero-token smoke дополнительно проверяет persistent settings/queue, запрет automatic local project defaults и safe Git revert. Это важно, потому что CI не может доказать состояние конкретного host/OpenCode/Qdrant.

## Security boundaries

- `.env` не tracked;
- web Basic Auth;
- recommended loopback bind;
- project root allowlist + symlink containment;
- scratch containment;
- workflow state user-only;
- local models manual-only, без workflow lifecycle/routing;
- ordinary direct agents deny automatic subagent/RAG;
- orchestrated read worker deny-first;
- project permission automation только из explicit saved rules;
- safe bounded Git revert;
- MCP execution timeout.
