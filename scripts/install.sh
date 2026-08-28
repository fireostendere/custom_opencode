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

APP_DIR=${OPENCODE_WEB_INSTALL_DIR:-"$HOME/.local/share/opencode/oc-web"}
CONFIG_DIR=${OPENCODE_CONFIG_DIR:-"$HOME/.config/opencode"}
UNIT_DIR="$HOME/.config/systemd/user"
BIN_DIR="$HOME/.local/bin"
SCRATCH_DIR=${OPENCODE_SCRATCH_DIRECTORY:-"$HOME/opencode-scratch"}

install -d "$APP_DIR" "$UNIT_DIR" "$BIN_DIR" "$SCRATCH_DIR"
install -m 0644 "$ROOT/app/index.html" "$ROOT/app/site.webmanifest" "$ROOT/app/README.md" "$APP_DIR/"
install -m 0755 "$ROOT/app/server.py" "$APP_DIR/server.py"
install -m 0600 "$ENV_FILE" "$APP_DIR/.env"
install -m 0644 "$ROOT/systemd/opencode-web-client.service" "$UNIT_DIR/opencode-web-client.service"

if [[ ${INSTALL_OPENCODE_CONFIG:-1} == 1 ]]; then
  install -d "$CONFIG_DIR/plugins" "$CONFIG_DIR/prompts"
  if [[ -f "$CONFIG_DIR/opencode.json" ]]; then
    cp -p "$CONFIG_DIR/opencode.json" "$CONFIG_DIR/opencode.json.backup.$(date +%Y%m%d%H%M%S)"
  fi
  install -m 0644 "$ROOT/config/AGENTS.md" "$CONFIG_DIR/AGENTS.md"
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

cat >"$BIN_DIR/custom-opencode" <<EOF
#!/usr/bin/env bash
set -a
source "$APP_DIR/.env"
set +a
if command -v opencode2 >/dev/null 2>&1; then
  exec opencode2 "\$@"
fi
exec opencode "\$@"
EOF
chmod 0755 "$BIN_DIR/custom-opencode"

systemctl --user daemon-reload
systemctl --user enable --now opencode-web-client.service
echo "Installed. Start OpenCode with: custom-opencode"
