# Эксплуатация и recovery

## Запуск

После установки основной launcher:

```bash
custom-opencode
```

Web client работает через user systemd service:

```bash
systemctl --user status opencode-web-client.service --no-pager
```

Unit запускает `app/server_workflow.py` и автоматически рестартуется при падении.

В TUI команда `/webserver` открывает wizard управления этим же unit:

- при первом запуске подтверждает deploy через штатный `scripts/install.sh`;
- позволяет отдельно выбрать состояние сейчас и автозапуск по умолчанию;
- повторный запуск меняет `start/stop` и `systemctl enable/disable` без удаления deploy;
- `/webserver status` показывает состояние и адрес.

Настройка host/port и авторизации остаётся в `.env`. Небезопасные credentials в
state wizard не записываются; состояние хранится в
`~/.config/opencode/webserver.json` с правами `0600`.

## Обновление

```bash
custom-opencode-update
```

Последовательность:

1. `git fetch --prune origin main`;
2. `git merge --ff-only FETCH_HEAD`;
3. повторный installer;
4. pre-install verifier;
5. config render/install;
6. restart services;
7. post-install host self-test.

При существующем `.env` updater добавляет `OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT=1` только когда нет строки, начинающейся точно с `OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT=`. Строки с `export` или ведущими пробелами ключом не считаются; значение канонической строки сохраняется.

Если используется RAG и в нём были изменения, сначала обновите `mcp-rag`:

```bash
cd /path/to/mcp-rag
git pull --ff-only
```

Затем запускайте `custom-opencode-update`.

## Логи

Web service:

```bash
journalctl --user -u opencode-web-client.service -n 200 --no-pager
journalctl --user -u opencode-web-client.service -f
```

OpenCode backend диагностируйте отдельно через его service/status tooling.

RAG/Qdrant:

```bash
cd /path/to/mcp-rag
docker compose ps
docker compose logs --tail=200 qdrant
```

## Быстрая проверка host

```bash
./scripts/verify.sh
python3 ./scripts/install-selftest.py --rag-enabled
```

Вторую команду используйте с `--rag-enabled`, только если RAG действительно настроен.

В web UI:

```text
/rag-start quick
```

## Backup перед рискованным обновлением

Сохраняйте:

```text
custom_opencode/.env
~/.config/opencode/opencode.json
~/.config/opencode/AGENTS.md
~/.config/opencode/prompts/
~/.config/opencode/plugins/
~/.local/share/opencode/auth.json
~/.config/opencode/webserver.json
~/.config/systemd/user/opencode-web-client.service
```

Для RAG отдельно важно сохранить/зафиксировать:

- `data/knowledge.db`;
- `config/settings.yaml`;
- `config/sources.yaml`;
- Qdrant volume/data;
- текущий collection name;
- commit SHA.

Не копируйте огромный Qdrant volume на каждое обычное обновление, но перед schema/rebuild изменениями backup обязателен.

## Runtime config backup

Installer перед заменой существующего `opencode.json` создаёт timestamped backup.

Это не заменяет backup `.env` и auth storage.

## Recovery при сломанном installer/self-test

Нормальный порядок:

1. прочитать конкретный failing check;
2. исправить backend/service/RAG/config;
3. повторить `./scripts/verify.sh`;
4. повторить `./scripts/install.sh`.

Только если installer невозможно запустить из-за сломанного runtime, временно:

```text
CUSTOM_OPENCODE_INSTALL_SELFTEST=0
```

После восстановления обязательно вернуть `1` и прогнать self-test вручную.

## Recovery web service

```bash
systemctl --user daemon-reload
systemctl --user restart opencode-web-client.service
systemctl --user status opencode-web-client.service --no-pager
```

Проверьте, что установленный unit содержит актуальный `server_rag.py`.

## Recovery RAG

Первое действие:

```text
/rag-start quick
```

Если UI недоступен:

```bash
cd /path/to/mcp-rag
.venv/bin/python -m knowledge_base.runtime --json --no-start
```

Если Qdrant просто остановлен:

```bash
.venv/bin/python -m knowledge_base.runtime --json
```

Если collection отсутствует или schema manifest несовместим, не пытайтесь лечить это `/rag-start`. Используйте осознанную rebuild процедуру из документации `mcp-rag`.

## Что нельзя делать как обычный recovery

Не используйте без понимания последствий:

```text
git reset --hard
docker compose down -v
удаление data/knowledge.db
удаление Qdrant storage
автоматический ingest-all на старте
копирование .env.example поверх .env
```

Эти действия могут удалить локальные изменения, credentials или индекс.

## Проверка после OpenCode V2 upgrade

OpenCode V2 остаётся изменяющимся upstream. После значимого upgrade:

1. `./scripts/verify.sh`;
2. install/update self-test;
3. `/rag-start quick`, если есть RAG;
4. открыть реальный проект через `Проекты`;
5. проверить native slash command.

## Проверка после изменения router config

Бесплатно: verifier, `/rag-start quick` и runtime probe при настроенном RAG.

## Обновление `.env`

При появлении новых variables:

1. сохранить `.env.backup.<timestamp>`;
2. сравнить `.env.example` и `.env`;
3. добавить новые keys;
4. сохранить существующие реальные secrets;
5. проверить `source .env`;
6. выполнить installer/self-test.

Не храните credentials в `config/opencode.json.template` или tracked docs.
