# VSCode: хоткеи OpenCode в интегрированном терминале

## Проблема

VSCode перехватывает комбинации на уровне workbench **до** того, как они доходят до
терминала. Поэтому при фокусе в терминале `ctrl+f` открывает поиск по терминалу,
`ctrl+p` — Quick Open и т.д., а OpenCode TUI нужный байт просто не видит.
«Мягкого» фолбэка («терминал не съел → сработал VSCode») не существует:
у workbench нет канала спросить TUI, использует ли он клавишу.

## Решение (уровень 1: перехват по фокусу)

В пользовательском `keybindings.json` (`%APPDATA%\Code\User\keybindings.json`)
на каждый конфликтующий ключ:

- снимаем дефолтную команду в контексте терминала (запись с `-` перед command);
- добавляем `workbench.action.terminal.sendSequence` c `when: "terminalFocus"`,
  который шлёт в терминал сырой байт, соответствующий `ctrl+<буква>`.

Вне терминала всё остаётся как было (поиск, Quick Open, сайдбар).
В фокусе терминала байт уходит в OpenCode. Leader-биндинги (`<leader>…`,
лидер `ctrl+x`) не конфликтуют и трогать их не нужно.

Эталонный сниппет (актуальная копия лежит в user keybindings.json):

```json
[
  { "key": "ctrl+p", "command": "-workbench.action.quickOpen", "when": "terminalFocus" },
  { "key": "ctrl+p", "command": "workbench.action.terminal.sendSequence",
    "args": { "text": "\u0010" }, "when": "terminalFocus" },
  { "key": "ctrl+f", "command": "-workbench.action.terminal.focusFind", "when": "terminalFocus" },
  { "key": "ctrl+f", "command": "workbench.action.terminal.sendSequence",
    "args": { "text": "\u0006" }, "when": "terminalFocus" },
  { "key": "ctrl+r", "command": "-workbench.action.terminal.runRecentCommand", "when": "terminalFocus" },
  { "key": "ctrl+r", "command": "workbench.action.terminal.sendSequence",
    "args": { "text": "\u0012" }, "when": "terminalFocus" },
  { "key": "ctrl+b", "command": "-workbench.action.toggleSidebarVisibility", "when": "terminalFocus" },
  { "key": "ctrl+b", "command": "workbench.action.terminal.sendSequence",
    "args": { "text": "\u0002" }, "when": "terminalFocus" }
]
```

| Клавиша | Байт | Действие в OpenCode (дефолты) |
| --- | --- | --- |
| `ctrl+p` | `\u0010` | `command_list`, `dialog.select.prev` |
| `ctrl+f` | `\u0006` | `model_favorite_toggle` (в диалоге моделей), `input_move_right` (в input) |
| `ctrl+r` | `\u0012` | `session_rename` |
| `ctrl+b` | `\u0002` | `input_move_left` |

Байт для `ctrl+<буква>` = номер буквы в алфавите (`a`=0x01 … `z`=0x1A),
например `ctrl+g` = `\u0007`. Конфликтующую команду VSCode смотреть в
*Preferences: Open Default Keyboard Shortcuts (JSON)*.

## Цена и оговорки

- В голом шелле (без OpenCode) эти `ctrl+…` становятся readline-клавишами
  (движение курсора), а не командами VSCode — обычно не критично.
- Поиск по терминалу больше не `ctrl+f`: команда палитры
  `Terminal: Focus Find` (`workbench.action.terminal.focusFind`)
  или повесьте свой биндинг на другую комбинацию.
- Глобальный `terminal.integrated.sendKeybindingsToShell: true` не использовать —
  это «железный» режим, кладёт все биндинги VSCode в терминале.

## Уровни 2–3 (если захочется «только пока открыт диалог»)

- Уровень 2 (хак): `when: "terminalFocus && !terminalShellType"` — на Claude Code
  замечено, что контекст сбрасывается, пока TUI держит терминал. Проверить для
  opencode: `Ctrl+Shift+P` → *Developer: Inspect Context Keys* → клик по терминалу
  с запущенным и остановленным opencode, сравнить ключи.
- Уровень 3 (честный): мини-расширение VSCode: TUI-плагин при открытии/закрытии
  диалога пишет state-файл, расширение следит `FileSystemWatcher`-ом и дёргает
  `setContext('opencode.dialogOpen', …)`; биндинг живёт при
  `terminalFocus && opencode.dialogOpen`.

Биндинги применяются без перезапуска VSCode (файл подхватывается на лету);
если не применились — *Reload Window*.
