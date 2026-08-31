# Web UI, авторизация и оформление

## Авторизация

Web-клиент больше не использует browser-native Basic Auth как основной пользовательский вход. Неавторизованный HTML-запрос перенаправляется на `/login.html`, а API/client endpoints возвращают обычный JSON `401` без `WWW-Authenticate` challenge.

Вход выполняется через `/auth/login`. После успешной проверки сервер выдаёт подписанную `HttpOnly` cookie `opencode_session`:

- пароль не сохраняется в `localStorage`;
- `SameSite=Strict` включён всегда;
- `Secure` определяется автоматически по `X-Forwarded-Proto`/`Forwarded` либо задаётся явно;
- изменение web password инвалидирует старые session cookies, потому что ключ подписи производен от текущего credential;
- `Выйти` очищает cookie, auth-sensitive cache и отзывает текущий token на время жизни server process.

Переключатель `Запомнить вход` сохраняет только пользовательское предпочтение и имя пользователя в localStorage. Долгоживущая cookie по умолчанию действует 30 дней; обычная session cookie имеет серверный TTL 24 часа и не получает `Max-Age`.

Неудачные попытки входа имеют bounded server-side throttle. Это не заменяет firewall/Tailscale ACL, но не позволяет бесконечно параллельно перебирать web credential через один client identity.

Если сессия истекла во время работы, клиент запоминает полный текущий route, включая `#/session/...`, открывает login и после успешного входа возвращает пользователя в тот же диалог.

Legacy Basic Auth можно включить только для старых клиентов через `OPENCODE_AUTH_ALLOW_BASIC=1`. Для обычного web UI рекомендуемое значение — `0`.

## Локальный bypass

Default — `OPENCODE_WEB_ALLOW_LOCAL=0`: даже прямой loopback требует login cookie.

Если `OPENCODE_WEB_ALLOW_LOCAL=1` включён вручную, passwordless bypass действует только для **прямого** localhost-запроса, где одновременно:

- TCP peer loopback;
- `Host` указывает на loopback/localhost;
- отсутствуют `Forwarded`, `X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Proto`.

Это принципиально важно для topology `телефон → Tailscale/Caddy/nginx → 127.0.0.1:4098`: локальный reverse proxy сам подключается с loopback, но его удалённый пользователь **не** получает localhost bypass и обязан пройти обычный login.

Для любого LAN/tailnet/reverse-proxy deployment оставляйте `OPENCODE_WEB_ALLOW_LOCAL=0`.

## Настройки оформления

`Аккаунт → Настройки` открывает локальные настройки интерфейса:

- тема: `Системная`, `Светлая`, `Тёмная`;
- шесть готовых accent colors;
- произвольный accent через native color picker;
- сброс к `system + #10a37f`.

Настройки хранятся только в браузере под ключом `opencode:web:appearance-v1`. Это не project/server state и не содержит секретов.

`Системная` тема отслеживает `prefers-color-scheme` и меняется без reload. Небольшой synchronous `appearance-bootstrap.js` в `<head>` применяет сохранённую тему до загрузки основного CSS, чтобы избежать заметной вспышки неправильной темы и не нарушать правило main app без inline JavaScript.

Login page использует те же сохранённые theme/accent preferences до первого paint. Login bootstrap остаётся self-contained, чтобы страница входа не зависела от auth-protected application modules.

## Микроанимации

UI использует короткие transition/animation только для действий, где движение помогает понять состояние:

- открытие dialog;
- появление permission/question/status surface;
- toast;
- sidebar drawer;
- progress bars;
- press/focus feedback кнопок и controls.

При `prefers-reduced-motion: reduce` длительные transitions/animations отключаются практически полностью.

## Mobile drawer

На ширине до 760 px sidebar ведёт себя как drawer:

- открывается кнопкой меню;
- закрывается свайпом справа налево;
- закрывается Android/browser Back до ухода со страницы;
- закрывается тапом по затемнённой области или любым кликом вне drawer;
- выбор session корректно потребляет synthetic history entry, поэтому лишний Back после навигации не нужен.

## Web regression

Репозиторий содержит два уровня browser regression.

Короткие live-сценарии для уже запущенного пользовательского инстанса:

```bash
python3 scripts/web-e2e.py
python3 scripts/browser-smoke.py
python3 scripts/live-web-smoke.py
```

Они используют URL/credential из `.env`; permission response в `web-e2e.py` перехватывается браузером и не отправляется реальному OpenCode.

Для CI используется изолированный deterministic fixture:

```bash
python3 scripts/web-security-smoke.py
python3 scripts/queue-badge-convergence.py
python3 scripts/web-fixture-e2e.py
```

`web-fixture-e2e.py` запускает настоящий production `server_workflow.Handler` и настоящий JS/CSS UI против маленького in-process V2 fixture backend. Он не вызывает модель, не тратит токены и проверяет desktop/mobile login, session navigation, model picker, permission lifecycle, composer, appearance и mobile drawer.

`web-security-smoke.py` отдельно фиксирует regression на reverse-proxy localhost bypass, replay cookie после logout и login throttle.

## Лимиты и диалоги

Панель provider limits сворачивается через `Лимиты` и запоминает состояние в localStorage.

Mobile dialogs используют доступный `dvh` viewport вместо жёсткого малого `vh` cap. Scroll находится внутри modal, поэтому header/close/action controls остаются доступными и окно не обрезается без причины.

На desktop ширина sidebar изменяется перетаскиванием вертикального разделителя, клавишами `←`/`→` или двойным кликом для сброса; значение сохраняется локально. Model/effort controls и project settings строятся из актуального `/api/model` каталога, а не из отдельного захардкоженного списка.

## Execution mode

Пользовательский интерфейс фиксирован в `Build`. Переключатель `Build / Plan` скрыт, а старые/внешние попытки перевести session в `plan` перенаправляются обратно в соответствующий Build agent profile.

Оркестрация по-прежнему выбирается моделью/profile в model picker, а не отдельным режимом UI.
