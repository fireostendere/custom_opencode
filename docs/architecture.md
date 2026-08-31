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
- Build-only пользовательский execution surface;
- direct/orchestrated model profiles;
- native question cards с single/multi-select и custom answer;
- project memory/defaults/permission policy;
- session-scoped compact permission cards;
- advanced Changes/Review с file/hunk revert;
- orchestration tree;
- model/context/cost/runtime/RAG/queue status bar;
- files/images, Markdown/code/tool/reasoning rendering;
- drafts, deep links и actionable PWA notifications;
- provider quotas, `/rag-start`, project browser;
- mobile drawer с swipe/Back/outside-click dismissal;
- persisted light/dark/system theme и accent color;
- reduced-motion-aware microanimations.

Локальные Ollama models остаются manual-only ordinary model entries model picker. Workflow layer не реализует local/cloud router и не управляет local runtime.

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

`server.py` — custom cookie auth, optional legacy Basic compatibility, same-origin proxy, quick-session isolation и scratch cleanup.

`server_ext.py` — provider-limit bridges.

`server_plus.py` — constrained host-directory browser, symlink containment и общие backend helpers.

`server_rag.py` — `/rag-start`, MCP workspace routing, dynamic `kb` connect и persisted RAG enablement.

`server_features.py` — persistent queue/project settings, project permission rules, safe Git revert и background queue worker.

`server_workflow.py` — production entrypoint. Он композиционно сохраняет RAG routes, добавляет workflow send path и отправку project memory через OpenCode `system` context.

Systemd запускает `app/server_workflow.py`.

## Web auth boundary

Неавторизованный HTML переводится на `/login.html`; API/client endpoints получают JSON `401`. Обычный серверный ответ не содержит `WWW-Authenticate`, поэтому browser-native credential prompt не является основным UX.

После `/auth/login` выдаётся подписанная `HttpOnly; SameSite=Strict` cookie. `Secure` определяется HTTPS/reverse-proxy settings. Remembered login управляет только TTL cookie; password в browser storage не записывается.

Полный текущий route сохраняется перед re-auth, поэтому возврат после login идёт в тот же `#/session/...`.

Legacy Basic compatibility отключена по умолчанию и включается только `OPENCODE_AUTH_ALLOW_BASIC=1`.

## Persistent workflow state

По умолчанию state находится в:

```text
$XDG_STATE_HOME/custom-opencode/web-features.json
```

или `~/.local/state/custom-opencode/web-features.json`.

Файл создаётся с user-only permissions и содержит workflow metadata: queued prompts/attachments, project preferences и permission rules. Secrets туда не записываются.

Queue worker живёт внутри production web process. Он может дождаться завершения run и отправить следующий queued prompt, даже если браузер/PWA закрыт.

Browser-only appearance/login UI preferences в этот файл не попадают и хранятся отдельно в local/session storage.

## Quick sessions и project boundary

Quick session создаётся в отдельном `<scratch>/session-<random>/`. Cleanup разрешён только после containment check.

Project browser и workflow endpoints используют canonicalized path и `OPENCODE_PROJECT_ROOTS`. Symlink/path traversal за allowlist не допускается.

Git revert дополнительно проверяет целевой relative path и для hunk принимает только patch, заголовки которого относятся к выбранному файлу.

## Build-only UI и model profiles

Пользовательский execution mode в текущем UI всегда Build. Visible `Build / Plan` переключатель удалён.

Внутри compatibility layer могут существовать `plan`/`plan-direct`, но `access-fix.js`:

- скрывает agent mode control;
- переводит активный `plan` обратно в соответствующий Build agent;
- скрывает project default mode selector и фиксирует его в `build`.

Model picker отдельно выбирает profile:

```text
обычная модель                    → build-direct
Qwen 3.8 Max · Оркестрированная   → build
```

Локальный provider остаётся ordinary direct model choice только при реальном ручном выборе пользователя. Project defaults, persistent queue и workflow worker не имеют automatic `ollama/*` route.

## Composer и queue

```text
нет active run                  → send
active run + empty composer     → cancel
active run + text/attachment    → persistent queue
```

Скрытые native controls остаются compatibility layer, но пользователь не выбирает `Steer/Queue` вручную.

Queue worker отправляет prompt с уже выбранным model/provider текущей session. Он не переключает model и не выполняет model lifecycle actions.

## Native questions

OpenCode question request не преобразуется в обычный текст. Web UI получает pending native request и показывает header/question, options, single/multiple selection и custom text. Reply отправляется native question endpoint как `answers: string[][]`.

## Project memory и defaults

Project settings привязаны к canonical directory. Persistent instructions при submit передаются отдельным `system` field current OpenCode message API, поэтому не отображаются как часть user message.

Проект может задавать model profile, RAG preference и permission rules. Execution mode в текущем UX принудительно Build.

`auto` и `ollama/*` не принимаются как автоматические project defaults. Это не влияет на ручной выбор Ollama в model picker.

## Permissions

Permission banner привязан к текущей session: approval другого диалога не показывается поверх активной session. После `Разрешить / Отклонить / Всегда` карточка скрывается сразу, а delayed polling не должен возвращать уже resolved request.

Summary строится из action/resource metadata (`команда`, `файл`, `URL`, `подзадача`), raw payload остаётся под details.

Project policy имеет ordered rules:

```text
action glob + resource glob → ask | allow | deny
```

R3/R4 control-plane boundaries остаются интерактивными независимо от project allow.

## Appearance layer

`appearance.js` хранит `{theme, accent}` в `opencode:web:appearance-v1`. `system` использует `prefers-color-scheme`; accent применяется через CSS custom property и автоматически выбирает контрастный foreground.

`appearance.css` загружается последним и переводит legacy dark-only surfaces на palette variables, поэтому светлая тема охватывает core UI, workflow surfaces, review, dialogs и sidebar.

Microanimations ограничены короткими transitions и появлением stateful surfaces. `prefers-reduced-motion` почти полностью отключает motion.

## Mobile drawer

Drawer использует synthetic history entry: первый browser/Android Back закрывает sidebar, а не покидает приложение. Также поддерживаются swipe справа налево и tap/click вне панели через scrim/capture handler.

## Orchestration trace и RAG

Child/subagent sessions намеренно не возвращаются в sidebar. Текущая root session показывает trace с primary + child nodes, model/agent/status/runtime и RAG marker при использовании knowledge tools.

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

Zero-token smoke проверяет persistent settings/queue, запрет automatic local project defaults и safe Git revert. Host-level RAG readiness проверяется отдельным `/rag-start` и RAG runtime probe.

## Security boundaries

- `.env` не tracked;
- custom signed HttpOnly web session; legacy Basic off by default;
- recommended loopback bind;
- project root allowlist + symlink containment;
- scratch containment;
- workflow state user-only;
- local models manual-only, без workflow lifecycle/routing;
- ordinary direct agents deny automatic subagent/RAG;
- orchestrated read worker deny-first;
- project permission automation только из explicit saved rules и в пределах R0-R4 policy;
- safe bounded Git revert;
- MCP execution timeout.
