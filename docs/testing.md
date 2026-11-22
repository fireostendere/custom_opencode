# Проверка и тесты

Всё, что проверяет продукт, лежит в `tests/`. В `scripts/` — установка и эксплуатация; `scripts/verify.sh` остаётся там, потому что это pre-install gate: его вызывают `bootstrap.sh` и `install.sh`.

## Что запускать

| Когда | Команда | Что делает |
|---|---|---|
| Перед PR, быстро (около минуты, офлайн) | `bash scripts/verify.sh` | синтаксис, контракты шаблона конфигурации, быстрые regression/smoke |
| Точечная правка | `node tests/<имя>-regression.mjs`, `python3 tests/<имя>-smoke.py` | один набор |
| Полностью, как в CI (около восьми минут) | `python3 tests/matrix.py --output /tmp/custom-opencode-matrix` | все model-free наборы; лог на каждый и общий `report.json` |
| Один набор матрицы | `python3 tests/matrix.py --output DIR --suite web-security` | имена наборов — `SUITES` в `tests/matrix.py` |

Матрица не останавливается на первом отказе и возвращает ненулевой код при любом. Ей нужны Python 3.12, Node 22, Playwright 1.57.0 с Chromium, bubblewrap, зависимости из `scripts/tool-fabric-requirements.txt` и закреплённый `opencode2` (`OPENCODE2_BIN` задаёт проверяемый бинарник). Каждый набор получает собственный временный `HOME`; `OPENCODE_*`, ключи провайдеров и пользовательское состояние в наборы не попадают.

Платный inference нигде не запускается автоматически.

## CI

`main` защищён четырьмя обязательными job'ами единственного workflow `Clean Regression`:

| Job | Что проверяет |
|---|---|
| `model-free-matrix` | `tests/matrix.py` целиком, включая браузерные наборы |
| `native-clean-install` | `install.sh` в чистый `HOME` с настоящими зависимостями, затем native API и TUI; провайдеры смотрят в закрытый loopback-порт |
| `native-budget-wire` | настоящий закреплённый CLI, MCP stdio-сервер и локальный детерминированный HTTP-провайдер: wire-лимиты, один 503 с повтором, следующий пользовательский ход. Проверяет протокол, а не интеллект модели |
| `kernel-sandbox` | реальная изоляция bubblewrap и приёмка Tool Fabric; на ядре без поддержки preflight возвращает `BLOCKED_ENV` (exit 77), и это не засчитывается как PASS |

Защита ветки включается явной административной командой:

```bash
bash scripts/protect-main.sh fireostendere/custom_opencode
```

Она требует `gh` login с правом Administration, проверяет, что четыре job'а зелёные именно на текущем `main`, и только потом включает strict required checks, обязательный PR, защиту для администраторов и запрет force push. Обязательных approvals нет: проект индивидуальный.

## Новый тест

Файл в `tests/` должен запускаться из `tests/matrix.py`, `scripts/verify.sh` или workflow. `tests/workflow-cli-consistency.py` (входит в матрицу) роняет CI, если до файла не дотягивается ни один workflow. Проверки, которым нужен живой провайдер, запущенный сервис или настоящий терминал, перечислены в `MANUAL_TESTS` в том же файле.

Правило появилось не на пустом месте: `web-runtime-status-e2e.py` до версии 2.0 жил только в локальном раннере и успел устареть в трёх местах.

## Ручные проверки

| Скрипт | Что нужно |
|---|---|
| `tests/live-web-smoke.py`, `tests/web-e2e.py` | запущенный web-сервер; токены модели не тратятся |
| `tests/dnd-watch-live.py` | настоящий native-движок и локальные MCP/provider-фикстуры |
| `tests/mcp-reconnect-live.py` | настоящий native-сервис и одноразовый падающий stdio-MCP |
| `tests/native-interrupt-live.py` | настоящий терминал (PTY) |
| `tests/rag-live-regression.py` | checkout `mcp-rag` с корпусом, индексом и Qdrant |

`tests/native-runtime-smoke.mjs` и `tests/native-tui-smoke.py` запускает `native-clean-install`; им нужен отдельный тестовый `HOME` с маркером `.custom-opencode-audit-home`, на пользовательском `HOME` они не работают.
