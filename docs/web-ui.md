# Web UI, авторизация и оформление

## Авторизация

Web-клиент больше не использует browser-native Basic Auth как основной пользовательский вход. Неавторизованный HTML-запрос перенаправляется на `/login.html`, а API/client endpoints возвращают обычный JSON `401` без `WWW-Authenticate` challenge.

Вход выполняется через `/auth/login`. После успешной проверки сервер выдаёт подписанную `HttpOnly` cookie `opencode_session`:

- пароль не сохраняется в `localStorage`;
- `SameSite=Strict` включён всегда;
- `Secure` определяется автоматически по `X-Forwarded-Proto`/`Forwarded` либо задаётся явно;
- изменение web password инвалидирует старые session cookies, потому что ключ подписи производен от текущего credential;
- `Выйти` очищает cookie и auth-sensitive cache.

Переключатель `Запомнить вход` сохраняет только пользовательское предпочтение и имя пользователя в localStorage. Долгоживущая cookie по умолчанию действует 30 дней; обычная session cookie имеет серверный TTL 24 часа и не получает `Max-Age`.

Если сессия истекла во время работы, клиент запоминает полный текущий route, включая `#/session/...`, открывает login и после успешного входа возвращает пользователя в тот же диалог.

Legacy Basic Auth можно включить только для старых клиентов через `OPENCODE_AUTH_ALLOW_BASIC=1`. Для обычного web UI рекомендуемое значение — `0`.

## Локальный bypass

При `OPENCODE_WEB_ALLOW_LOCAL=1` loopback-клиент может работать без login cookie. В sidebar такой доступ помечается как локальный, а кнопка logout скрывается.

## Настройки оформления

`Аккаунт → Настройки` открывает локальные настройки интерфейса:

- тема: `Системная`, `Светлая`, `Тёмная`;
- шесть готовых accent colors;
- произвольный accent через native color picker;
- сброс к `system + #10a37f`.

Настройки хранятся только в браузере под ключом `opencode:web:appearance-v1`. Это не project/server state и не содержит секретов.

`Системная` тема отслеживает `prefers-color-scheme` и меняется без reload. Небольшой inline bootstrap в `<head>` применяет сохранённую тему до загрузки основного CSS, чтобы избежать заметной вспышки неправильной темы.

Login page использует те же сохранённые theme/accent preferences без публикации auth-protected application assets до входа.

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

## Лимиты и диалоги

Панель provider limits сворачивается через `Лимиты` и запоминает состояние в localStorage.

Mobile dialogs используют доступный `dvh` viewport вместо жёсткого малого `vh` cap. Scroll находится внутри modal, поэтому header/close/action controls остаются доступными и окно не обрезается без причины.

## Execution mode

Пользовательский интерфейс фиксирован в `Build`. Переключатель `Build / Plan` скрыт, а старые/внешние попытки перевести session в `plan` перенаправляются обратно в соответствующий Build agent profile.

Оркестрация по-прежнему выбирается моделью/profile в model picker, а не отдельным режимом UI.
