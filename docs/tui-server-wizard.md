# TUI Server Wizard

Конфигурационный wizard для управления web server работает только в OpenCode V2 TUI. Web/PWA для этого потока не используется. В command palette зарегистрирована кнопка для:

- `/server` и `/server status`.

`/server` открывает меню управления web server: статус, запуск/остановка, автозапуск, порт/адрес, управление пользователями. `/server status` показывает текущий статус без открытия меню.

## CLI contract

Wizard вызывает `custom-opencode-webserver` через stdout-last-line JSON protocol:

- `status` → `{ok, deployed, running, defaultEnabled, host, port, address, users?, usersError?}`
- `user-list` → `{ok, users:[{username, source:"env"|"store", created_at?}]}`
- `user-add --username NAME [--password PASS]` → `{ok, username, generatedPassword?, users:[...]}`
- `user-remove --username NAME` → `{ok, username, users:[...]}`
- `port --port N [--host H]` → `{ok, host, port, restarted, address}`
- `apply --running on|off --default on|off` → `{ok, ...status}`
- `default on|off` → `{ok, ...status}`
- `deploy --running on|off --default on|off` → `{ok, ...status}`

Ошибки возвращают `{ok:false, error}` с exit code 1.

## Menu flows

После открытия `/server` wizard показывает меню с опциями:

- **Статус**: адрес, состояние, автозапуск, пользователи.
- **Запустить или остановить**: выбор состояния через `apply --running`.
- **Автозапуск**: выбор через `default on|off`.
- **Порт и адрес**: интерактивный ввод порта (1-65535) и host (без пробелов/слэшей), подтверждение, вызов `port --port --host`.
- **Добавить пользователя**: ввод username (валидация `^[A-Za-z0-9._-]{1,64}$`), выбор "Ввести пароль" или "Сгенерировать пароль". При manual — ввод + повтор + валидация длины >= 8. При generate — показ сгенерированного пароля один раз через alert.
- **Удалить пользователя**: список store-users (env-user управляется через `.env`), подтверждение, вызов `user-remove --username`.
- **Выход**: возврат из меню.

Если web server не развёрнут (`deployed:false`), wizard предлагает развернуть через `deploy --running --default`.

## Security notes

- Сгенерированный пароль показывается один раз через alert и не попадает в toast.
- Manual password вводится дважды, не сериализуется в toast, только передаётся в `user-add --password`.
- Env-user (`source:"env"`) управляется через `.env` и не может быть удалён через wizard.
- Удалённый пользователь теряет все активные сессии немедленно.
- Port/host валидируются до вызова `port`; service перезапускается только если был active.

## Registration

Plugin ID: `custom.server-wizard`. Keymap layer: `mode:"global", priority:961`. Slash command: `server` с `arguments:true`. Group: `Services`. Palette и suggested: `true`.

Submit router перехватывает `/server` и `/server status` в prompt editor, предотвращает нативную отправку и вызывает `processCommand` с распарсенным результатом.

## Regression

Запуск без LLM-токенов и без сетевых запросов:

```bash
node scripts/tui-server-wizard-regression.mjs
```

Regression проверяет:

- `parseServerCommand`: `/server` → wizard, `/server status` → status, `/server blah` → error, other text → null.
- Registration: slash name `server`, group `Services`, priority 961, palette/suggested true.
- Status flow: toast содержит адрес и количество пользователей.
- Not-deployed → deploy flow: вызовы `[["status"],["deploy","--running","on","--default","on"]]`.
- Menu flows: toggle, autostart, port (с retry на невалидном вводе), add user manual (с retry на коротком пароле и mismatch), add user generate (alert с generatedPassword), remove user (с подтверждением), remove user empty store (alert path).
- Cancel at username prompt → back to menu → exit, no user-add call.
- Submit-router interception: typed `/server` + enter → prevented/stopped true, editor cleared, wizard status flow ran.

Дополнительные проверки loader и TUI submit transport:

```bash
node scripts/tui-regression.mjs
node scripts/panel-submit-regression.mjs
bash scripts/tui-package-smoke.sh
```
