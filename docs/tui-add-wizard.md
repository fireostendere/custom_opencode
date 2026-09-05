# TUI Add Wizard

Конфигурационные wizard’ы работают только в OpenCode V2 TUI. Web/PWA для этого
потока не используется. В command palette зарегистрированы кнопки для:

- `/add provider` и `/addprovider`;
- `/add model` и `/addmodel`;
- `/add mcp` и `/addmcp`;
- `/add mcp-profile` и `/addmcpprofile`;
- `/add skill` и `/addskill`;
- `/add orchestration` и `/addorchestration`.

`/add` открывает выбор типа, `/configure` — управление и диагностику. Подробности:
[MCP profiles](mcp-profiles.md). Каждый wizard требует финального подтверждения.

Пустой canonical command или alias открывает wizard. JSON после команды сохраняет
native path через `session.command`, поэтому существующий server-side
`config-manager.js` остаётся единственным местом записи. `/panel` не изменён.

## Аккаунты провайдеров

`/accounts` открывает штатный визард подключений OpenCode V2 из custom TUI.
Команда доступна также в palette как «Аккаунты провайдеров», включая стартовый
экран без активной сессии. Требуется версия V2 с поддержкой нескольких accounts
в `/connect`; custom plugin использует тот же экран и хранилище credentials.

Для двух аккаунтов Gemini:

1. Введите `/accounts`, выберите Google и пройдите доступный способ подключения.
2. Снова откройте `/accounts` → Google → `Add account` и подключите второй аккаунт.
3. В этом же окне переименуйте аккаунты, например «Личный» и «Рабочий».
4. Для переключения откройте `/accounts` → Google и нажмите Enter на нужном аккаунте.

Активный аккаунт отмечен в списке. Способы входа определяются установленной
интеграцией: API key, OAuth или команда авторизации. Вход через браузер доступен
только если его предоставляет интеграция Google; иначе нужны API-ключи аккаунтов.
Переключение меняет активный credential провайдера, а не создаёт отдельную сессию.
OAuth, обновление токенов и сохранение аккаунтов выполняет OpenCode.
Не передавайте ключи аргументами слеш-команды. Esc закрывает штатный визард.
Web/PWA этой командой не затрагивается.

Проверка маршрутизации команды без реальных аккаунтов и сетевых запросов:

```bash
node scripts/tui-accounts-regression.mjs
```

## Обновление каталога и Astra

Для перечитывания сохранённых моделей и оркестраций в уже открытом workspace
используйте `/refreshmodels` или пункт palette «Обновить список моделей».
Команда не запускает LLM и не перезапускает сервер. Это перечитывание текущего
каталога и общего managed registry, а не принудительная загрузка models.dev.

В установленном custom OpenCode через визард добавлены `openai/gpt-6-astra`
и `openai/gpt-6-astra-orchestrated` («GPT-6 Astra · Orchestrated»).
Во втором варианте Astra ведёт задачу, существующие `sol-role-builder*` на Terra
выполняют изменения, а роли `sol-fast-reader`/`sol-role-reviewer*` на Luna — анализ
и ревью. Эти записи хранятся в managed registry установленного OpenCode;
они не добавлены в шаблон конфигурации для новых установок.
Параметры базовой Astra сверены с [официальной карточкой модели](https://developers.openai.com/api/docs/models/gpt-6-astra).
Для явно включаемой скрытой модели JSON-путь `/addmodel` принимает `enabled: true`.
Служебные квитанции визарда сохраняются с `resume: false`.

## Regression

Запуск без LLM-токенов и без сетевых запросов:

```bash
node scripts/tui-add-wizard-regression.mjs
```

Regression вызывает зарегистрированные TUI command rows через mock-реализации
`dialog.prompt`/`dialog.select`/`dialog.confirm`. Это не live TUI acceptance.
Сгенерированный JSON проходит через настоящий
`config/plugins/config-manager.js`; registry сохраняется в изолированный временный
файл. Проверяются:

- все пять кнопок: provider, model, MCP, skill, orchestration;
- generic `/add provider` и typed `/add model`;
- native JSON alias `/addmcp {...}`;
- remote и local MCP;
- отмена wizard без mutation;
- ID/content/URL secret validation;
- итоговая file-backed persistence и synthetic receipts;
- фактическое применение provider/model/MCP/skill settings и orchestration policy;
- повторное применение сохранённых настроек после нового config-manager setup.

Для сохранения машиночитаемого отчёта:

```bash
node scripts/tui-add-wizard-regression.mjs \
  --report=docs/artifacts/tui-add-wizard-regression.json
```

Безопасный набор входов зафиксирован в
`docs/artifacts/tui-add-wizard-cases.json`. В нём нет реальных credentials.
Последний успешный набор результатов зафиксирован в
`docs/artifacts/tui-add-wizard-regression.json`.

Дополнительные проверки loader и TUI submit transport:

```bash
node scripts/tui-regression.mjs
node scripts/panel-submit-regression.mjs
bash scripts/tui-package-smoke.sh
```

Последняя команда требует установленный `opencode2` и проверяет загрузку
установленного TUI package на терминалах 80x24, 120x30 и 160x40; wizard mutation
регрессия выполняется отдельным скриптом выше.
