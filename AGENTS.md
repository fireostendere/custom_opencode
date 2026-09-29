# Правила для AI-агентов (custom_opencode)

Репозиторий — исходник установленного OpenCode: плагины `config/plugins/`, промпты `config/prompts/`, шаблон `config/opencode.json.template`, установщик `scripts/install.sh`, web/runtime `app/`.

## Git
- `main` защищён: 4 обязательных CI. Изменения — только через PR, слияние после зелёного CI.
- Каждая сессия работает в своём worktree и своей ветке: `git worktree add <папка> -b <ветка> origin/main`. Папка — на постоянном диске (например `../worktrees/` рядом с репозиторием), не в `/tmp`: при перезапуске WSL systemd очищает `/tmp`, и незакоммиченная работа пропадает. Общую рабочую копию не трогай — там может сидеть другая сессия, и чужой `git add -A` заберёт твои правки в чужой коммит.
- Коммить только свои файлы, без `git add -A` по общей копии.
- Перед PR: `bash scripts/verify.sh` (для точечных правок — профильные `scripts/*-regression.*`).

## Установленная копия
- Личные настройки владельца (модели агентов, свои агенты и промпты, флаги, Tool Fabric) — в приватном репо `CUSTOM_OPENCODE_USER_CONFIG` (`settings.env`, `opencode.overlay.json`, см. `docs/configuration.md#private-user-config`), не в шаблоне и не в `.env`; в `.env` только секреты.
- `~/.config/opencode` руками не правь: установщик пересобирает `opencode.json` из шаблона и копирует `config/plugins/*.js` и `config/prompts/`, ручные правки теряются.
- Правка → PR → слияние → `scripts/install.sh`. Сервис перезапускать так же, как установщик: `env -u OPENCODE_CONFIG_DIR opencode2 service stop`, затем `start`. Процесс сервиса наследует окружение демона `opencode2`, поэтому новая переменная в `service.json` до него может не дойти — для поведения по умолчанию меняй дефолт в коде плагина.

## Секреты
- Ключи провайдеров — в `.env` (он в `.gitignore`), токены ODM — в `~/.config/odm/`. В git их нет и не должно быть.
- Локально стоит pre-commit хук `gitleaks git --pre-commit --staged`: коммит с токеном или ключом будет отклонён. `--no-verify` — только осознанно.

## D&D-линия
- Промпт стола: `config/prompts/dnd-edition.md` (стиль YOLO 21+, темп, автоожидание).
- Автоожидание: `config/plugins/dnd-watch.js` (`/dnd-watch status|stop|auto`, `DND_AUTO_WATCH=0` выключает). Push-сигналы ODM через `…/mcp/events` (`DND_WATCH_PUSH=0` — опрос), повтор упавшего хода, запрет сна (`DND_KEEP_AWAKE=0`), восстановление после перезапуска, статус мастера «думает/idle» в ODM (`DND_WATCH_STATUS=0` выключает). Статус вотчера — блок в боковой панели TUI (`config/plugins/tui/dnd-watch-panel.jsx`) и плашка в строке статуса веба (`app/dnd-watch-chip.js`, `app/dnd_watch.py`); тексты общие — `config/plugins/tui/lib/dnd-watch-describe.js` (без импортов: веб грузит его как есть). Подробно: `docs/configuration.md`.
- Luna Fast: `config/plugins/dnd-fast-tier.js`; роутер `dnd-super-orchestrator.js` выключен по умолчанию.
- Типизированный вывод ролей ODM (`narrator-ask|actor|referee`): `config/plugins/typed-output.js` + реестр `config/prompts/typed-output.json`; writer и `narrate.content` — проза.
