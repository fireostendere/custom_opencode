#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="$ROOT/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Create .env from .env.example first" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

CONFIG_DIR=${OPENCODE_CONFIG_DIR:-"$HOME/.config/opencode"}
UNIT_DIR="$HOME/.config/systemd/user"
BIN_DIR="$HOME/.local/bin"
SCRATCH_DIR=${OPENCODE_SCRATCH_DIRECTORY:-"$HOME/opencode-scratch"}
AUTH_FILE=${OPENCODE_AUTH_FILE:-"$HOME/.local/share/opencode/auth.json"}

install -d "$UNIT_DIR" "$BIN_DIR" "$SCRATCH_DIR" "$(dirname "$AUTH_FILE")"
sed "s|__CUSTOM_OPENCODE_ROOT__|$ROOT|g" "$ROOT/systemd/opencode-web-client.service" >"$UNIT_DIR/opencode-web-client.service"
chmod 0644 "$UNIT_DIR/opencode-web-client.service"

if [[ ${INSTALL_OPENCODE_CONFIG:-1} == 1 ]]; then
  install -d "$CONFIG_DIR/plugins" "$CONFIG_DIR/prompts"
  if [[ -f "$CONFIG_DIR/opencode.json" ]]; then
    cp -p "$CONFIG_DIR/opencode.json" "$CONFIG_DIR/opencode.json.backup.$(date +%Y%m%d%H%M%S)"
  fi
  install -m 0644 "$ROOT/config/AGENTS.md" "$CONFIG_DIR/AGENTS.md"
  install -m 0644 "$ROOT/config/cli.json" "$CONFIG_DIR/cli.json"
  install -m 0644 "$ROOT/config/events.js" "$CONFIG_DIR/events.js"
  install -m 0644 "$ROOT/config/prompts/"* "$CONFIG_DIR/prompts/"
  install -m 0644 "$ROOT/config/plugins/"* "$CONFIG_DIR/plugins/"
  python3 - "$ROOT/config/opencode.json.template" "$CONFIG_DIR/opencode.json" "$CONFIG_DIR" <<'PY'
import json, sys
source, target, config_dir = sys.argv[1:]
text = open(source, encoding="utf-8").read().replace("__CONFIG_DIR__", config_dir)
json.loads(text)
open(target, "w", encoding="utf-8").write(text)
PY
fi

python3 - "$AUTH_FILE" <<'PY'
import json, os, sys
target = sys.argv[1]
mapping = {
    "openai": {"type": "oauth", "access": "OPENCODE_OPENAI_ACCESS", "refresh": "OPENCODE_OPENAI_REFRESH", "expires": "OPENCODE_OPENAI_EXPIRES", "accountId": "OPENCODE_OPENAI_ACCOUNT_ID"},
    "opencode": {"type": "api", "key": "OPENCODE_ZEN_KEY"},
    "opencode-go": {"type": "api", "key": "OPENCODE_GO_KEY"},
}
try:
    with open(target, encoding="utf-8") as handle:
        auth = json.load(handle)
except (FileNotFoundError, json.JSONDecodeError):
    auth = {}
for provider, fields in mapping.items():
    values = {}
    for key, env in fields.items():
        if key == "type":
            values[key] = env
        elif os.environ.get(env) and os.environ.get(env) != "CHANGE_ME":
            values[key] = os.environ[env]
    if "expires" in values:
        values["expires"] = int(values["expires"])
    if len(values) > 1:
        auth[provider] = values
if auth:
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(auth, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.chmod(target, 0o600)
PY

cat >"$BIN_DIR/custom-opencode" <<EOF
#!/usr/bin/env bash
set -a
source "$ROOT/.env"
set +a
if command -v opencode2 >/dev/null 2>&1; then
  exec opencode2 "\$@"
fi
exec opencode "\$@"
EOF
chmod 0755 "$BIN_DIR/custom-opencode"

ln -sfn "$ROOT/scripts/update.sh" "$BIN_DIR/custom-opencode-update"

systemctl --user daemon-reload
systemctl --user enable --now opencode-web-client.service
if command -v opencode2 >/dev/null 2>&1; then timeout 45s opencode2 service restart >/dev/null 2>&1 || true; fi
systemctl --user restart opencode-web-client.service
echo "Installed. Start OpenCode with: custom-opencode"
