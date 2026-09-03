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
- итоговая file-backed persistence и synthetic receipts.

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
