# TUI Add Wizard

Конфигурационные wizard’ы работают только в OpenCode V2 TUI. Web/PWA для этого
потока не используется. В command palette зарегистрированы кнопки для:

- `/add provider` и `/addprovider`;
- `/add model` и `/addmodel`;
- `/add mcp` и `/addmcp`;
- `/add skill` и `/addskill`;
- `/add orchestration` и `/addorchestration`.

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

## Regression

Запуск без LLM-токенов и без сетевых запросов:

```bash
node scripts/tui-add-wizard-regression.mjs
```

Regression реально вызывает зарегистрированные TUI command rows и официальные
`dialog.prompt`/`dialog.select`-пути. Сгенерированный JSON проходит через настоящий
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
