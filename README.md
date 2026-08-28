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

Этот комплект настроен под личную подписку **Token Plan Personal Pro**, а не Team
Edition. Provider ID `bailian-cli` сохранён ради совместимости с существующими
сессиями и web-favorites, но сам каталог соответствует актуальному Personal allowlist
для OpenCode.

Текущие text/vision модели Personal Edition, опубликованные Alibaba для OpenCode:

- `qwen3.8-max`;
- `qwen3.8-flash`;
- `qwen3.7-max`;
- `qwen3.7-plus`;
- `qwen3.6-flash`;
- `glm-5.2`;
- `deepseek-v4-pro`;
- `deepseek-v4-pro-0813`;
- `deepseek-v4-flash-0731`.

Модели, доступные только через Team/Coding Plan, намеренно не показываются в
Personal model picker: это предотвращает выбор model ID, который Personal key не
обязан принимать.

Официальный пример Alibaba пока использует синтаксис OpenCode V1. В этом репозитории
он переведён в нативный V2 по migration contract OpenCode: AI SDK package получает
префикс `aisdk:`, provider `options` становятся `settings`, а model `modalities` —
`capabilities`. Tool capability задана явно для всех моделей, используемых через
OpenCode.

`qwen3.8-max-preview` оставлен только как compatibility catalog ID для старых сессий;
через V2 `modelID` он отправляет актуальный `qwen3.8-max`. Новые сессии следует
создавать на `qwen3.8-max` или другой актуальной Personal-модели.

API key хранится только в `TOKEN_PLAN_API_KEY` в приватном `.env`. Плагин проверки
квоты сначала использует этот env, а при его отсутствии может прочитать Bailian
config из `BAILIAN_CONFIG_PATH` (по умолчанию `~/.bailian/config.json`). Endpoint и
probe-модель также настраиваются через `.env`.

Personal Token Plan также включает image/video generation и Harness capabilities,
но Alibaba требует подключать такие генераторы через Skill/extension mechanism, а
не помещать их в обычный OpenCode chat model picker. Поэтому они не смешиваются с
LLM provider catalog.

## Секреты и сетевые адреса

Все пароли, ключи, локальные, LAN и tailnet-адреса хранятся только в `.env`.
Файл исключён из Git. Для передачи репозитория другому человеку используйте
`.env.example`; личный `.env` передавайте отдельно только через защищённый канал.

`./scripts/verify.sh` проверяет синтаксис Python/JavaScript/shell, ищет literal IPv4,
персональные абсолютные home-пути и распространённые форматы секретов, включая
Alibaba Token Plan `sk-sp-*`. Также он проверяет точный Personal model allowlist,
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
