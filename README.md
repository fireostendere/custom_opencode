# custom_opencode

Переносимый комплект OpenCode V2 с отдельным веб-интерфейсом.

## Что входит

- ChatGPT-подобный web/PWA-клиент со всеми локальными сессиями;
- быстрые сессии без выбора проекта;
- выбор Build/Plan, модели, провайдера и effort до создания сессии;
- локальные и удалённые модели из каталога OpenCode;
- файлы, вставка скриншотов, удаление сессий;
- SSE-поток ответа, рассуждений и вызовов инструментов;
- подтверждение разрешений OpenCode из браузера;
- конфигурация агентов, CLI-настройки, обработчик событий и плагины;
- systemd user-service и установщик.

## Native OpenCode V2 config

`config/opencode.json.template` хранится в нативном формате OpenCode V2: `providers`,
`package`, `settings`, `capabilities`, `agents`, `system` и упорядоченные
`permissions`. Это важно, потому что `opencode2` умеет читать V1-конфиг, но некоторые
старые поля модели (например `reasoning`) в V2 намеренно игнорируются.

`AGENTS.md` устанавливается в глобальный каталог OpenCode и обнаруживается V2
автоматически. Поле `instructions` в JSON не используется: текущий V2 сохраняет его,
но пока не подмешивает перечисленные файлы в контекст модели.

## Alibaba Cloud Model Studio

Провайдер `bailian-cli` сохранён ради совместимости со старыми сессиями, но работает
через официальный Anthropic-compatible endpoint Token Plan. В шаблон конфигурации
добавлен полный набор text/vision LLM из официального примера Token Plan Team для
OpenCode: Qwen 3.8/3.7/3.6, DeepSeek V4/V3.2, Kimi K2.7/K2.6/K2.5, GLM 5.2/5.1/5
и MiniMax M2.5.

Официальный пример Alibaba пока использует синтаксис OpenCode V1. В этом репозитории
он переведён в нативный V2 по migration contract OpenCode: AI SDK package получает
префикс `aisdk:`, provider `options` становятся `settings`, а model `modalities` —
`capabilities`. Tool capability задана явно для всех моделей, используемых через
OpenCode.

`qwen3.8-max-preview` оставлен как compatibility catalog ID для старых сессий, но в
V2 через `modelID` отправляет провайдеру актуальный `qwen3.8-max`. Новые сессии
следует создавать на `qwen3.8-max` или другой актуальной модели.

API key хранится только в `TOKEN_PLAN_API_KEY` в приватном `.env`. Плагин проверки
квоты сначала использует этот env, а при его отсутствии может прочитать Bailian
config из `BAILIAN_CONFIG_PATH` (по умолчанию `~/.bailian/config.json`). Endpoint и
probe-модель также настраиваются через `.env`.

Генераторы изображений, видео и аудио Token Plan намеренно не добавлены в обычный
model picker OpenCode: этот провайдер предназначен для chat/text/vision LLM.

## Секреты и сетевые адреса

Все пароли, ключи, локальные, LAN и tailnet-адреса хранятся только в `.env`.
Файл исключён из Git. Для передачи репозитория другому человеку используйте
`.env.example`; личный `.env` передавайте отдельно только через защищённый канал.

`./scripts/verify.sh` проверяет синтаксис Python/JavaScript/shell, ищет literal IPv4,
персональные абсолютные home-пути и распространённые форматы секретов, включая
Alibaba Token Plan `sk-sp-*`. Также он проверяет обязательный набор моделей Alibaba,
переменные endpoint/API key и запрещает возврат к V1-only полям provider/model/agent.

## Переносимые пути

Следующие пути можно переопределить в `.env`, не меняя код:

- `OPENCODE_CONFIG_DIR` — глобальный config OpenCode;
- `OPENCODE_AUTH_FILE` — auth.json OpenCode;
- `OPENCODE_SERVICE_FILE` — файл discovery общего V2 backend;
- `OPENCODE_LEGACY_AUTH_FILE` — legacy env с backend auth;
- `OPENCODE_CONFIG_BACKUP_DIR` — каталог резервных копий конфигурации;
- `BAILIAN_CONFIG_PATH` — локальный config Bailian CLI.

Путь к `python3` не фиксируется в systemd unit: установщик определяет его через
`command -v python3` и подставляет при установке.

## Установка

Требуются OpenCode V2, Python 3, Node.js и systemd user services.

```bash
cp .env.example .env
# заполнить .env
./scripts/verify.sh
./scripts/install.sh
```

После установки запускайте OpenCode командой `custom-opencode`, чтобы переменные
локальных и удалённых провайдеров загрузились из `.env`.

## Структура

- `app/` — веб-интерфейс и same-origin proxy;
- `config/` — шаблон OpenCode, агенты, prompts и плагины;
- `systemd/` — пользовательский сервис;
- `scripts/` — установка и проверка.

## Обновление

После клонирования репозиторий становится единственным источником веб-клиента,
сервера-прокси, плагинов и конфигурации. Не редактируйте копию в `~/.local`.

```bash
custom-opencode-update
```

Команда делает `git pull --ff-only`, синхронизирует конфигурацию и плагины,
перезапускает общий V2-сервис и веб-клиент. После ручного `git pull` запустите
эту команду или `./scripts/install.sh`.

## Известные места для следующей проверки

- `lazy-local-router` по умолчанию ждёт provider ID `llama-router`, тогда как
  текущий шаблон локального провайдера называется `ollama`. До унификации этих
  двух конфигураций lazy-start может не срабатывать для локальной модели.
- Web proxy использует Basic Auth поверх HTTP. Для внешнего доступа его следует
  держать за TLS/Tailscale/reverse proxy, а не публиковать напрямую в недоверенную сеть.
- OpenCode V2 всё ещё beta; перед обновлением upstream стоит прогонять
  `./scripts/verify.sh` и smoke-test web/API/plugin hooks.
