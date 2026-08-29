#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="$ROOT/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Create .env from .env.example first" >&2
  exit 1
fi

PYTHON3=$(command -v python3 || true)
if [[ -z "$PYTHON3" ]]; then
  echo "python3 is required" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

SHARED_CONFIG_DIR="$HOME/.config/opencode"
CONFIG_DIR=${OPENCODE_CONFIG_DIR:-"$SHARED_CONFIG_DIR"}
UNIT_DIR="$HOME/.config/systemd/user"
BIN_DIR="$HOME/.local/bin"
SCRATCH_DIR=${OPENCODE_SCRATCH_DIRECTORY:-"$HOME/opencode-scratch"}
AUTH_FILE=${OPENCODE_AUTH_FILE:-"$HOME/.local/share/opencode/auth.json"}
SELFTEST=${CUSTOM_OPENCODE_INSTALL_SELFTEST:-1}

if command -v opencode2 >/dev/null 2>&1 && [[ "$CONFIG_DIR" != "$SHARED_CONFIG_DIR" ]]; then
  echo "OpenCode V2 shared service loads its global config from $SHARED_CONFIG_DIR" >&2
  echo "Unset OPENCODE_CONFIG_DIR (or set it to that exact path) before installing." >&2
  exit 1
fi

RAG_ROOT=${MCP_RAG_ROOT:-}
if [[ -z "$RAG_ROOT" ]]; then
  for candidate in "$ROOT/../mcp-rag" "$HOME/mcp-rag"; do
    if [[ -f "$candidate/pyproject.toml" && -x "$candidate/.venv/bin/knowledge-mcp" ]]; then
      RAG_ROOT=$candidate
      break
    fi
  done
fi
RAG_BIN=${MCP_RAG_BIN:-}
if [[ -z "$RAG_BIN" && -n "$RAG_ROOT" ]]; then
  RAG_BIN="$RAG_ROOT/.venv/bin/knowledge-mcp"
fi
RAG_DISABLED=true
if [[ -n "$RAG_ROOT" && -n "$RAG_BIN" && -x "$RAG_BIN" ]]; then
  RAG_DISABLED=false
fi

if [[ "$SELFTEST" != 0 ]]; then
  echo "==> Pre-install verification"
  "$PYTHON3" -m py_compile "$ROOT/scripts/install-selftest.py"
  "$ROOT/scripts/verify.sh"
fi

install -d "$UNIT_DIR" "$BIN_DIR" "$SCRATCH_DIR" "$(dirname "$AUTH_FILE")"
"$PYTHON3" - "$ROOT/systemd/opencode-web-client.service" "$UNIT_DIR/opencode-web-client.service" "$ROOT" "$PYTHON3" <<'PY'
from pathlib import Path
import sys
source, target, root, python3 = sys.argv[1:]
text = Path(source).read_text(encoding="utf-8")
text = text.replace("__CUSTOM_OPENCODE_ROOT__", root).replace("__PYTHON3__", python3)
if "__CUSTOM_OPENCODE_ROOT__" in text or "__PYTHON3__" in text:
    raise SystemExit("Unresolved systemd template placeholder")
Path(target).write_text(text, encoding="utf-8")
PY
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
  "$PYTHON3" - "$ROOT/config/opencode.json.template" "$CONFIG_DIR/opencode.json" "$CONFIG_DIR" "$ROOT" "$RAG_DISABLED" <<'PY'
import json, sys
source, target, config_dir, root, rag_disabled = sys.argv[1:]
text = open(source, encoding="utf-8").read()
text = text.replace("__CONFIG_DIR__", config_dir)
text = text.replace("__CUSTOM_OPENCODE_ROOT__", root)
text = text.replace("__RAG_DISABLED__", rag_disabled)
json.loads(text)
open(target, "w", encoding="utf-8").write(text)
PY
fi

"$PYTHON3" - "$AUTH_FILE" <<'PY'
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
if command -v opencode2 >/dev/null 2>&1; then
  # The shared V2 service is long-lived and does not inherit variables from a
  # later custom-opencode client. Persist the canonical config path plus the
  # variables required by providers/plugins. Service configuration itself must
  # also be written through the standard shared-service root.
  SERVICE_OPENCODE=(env -u OPENCODE_CONFIG_DIR opencode2)
  SERVICE_ENV=(
    OPENCODE_CONFIG_DIR TOKEN_PLAN_API_KEY TOKEN_PLAN_ANTHROPIC_BASE_URL
    TOKEN_PLAN_OPENAI_BASE_URL TOKEN_PLAN_PROBE_MODEL OLLAMA_BASE_URL
    OPENCODE_LOCAL_AUTO_START OPENCODE_LOCAL_PROVIDER
    OPENCODE_LOCAL_ROUTER_URL OPENCODE_LOCAL_ROUTER_START
    OPENCODE_LOCAL_ROUTER_LOG BAILIAN_CONFIG_PATH
    QWEN_QUOTA_PROBE_ENABLED
  )
  for name in "${SERVICE_ENV[@]}"; do
    value=${!name:-}
    if [[ "$name" == OPENCODE_CONFIG_DIR ]]; then value=$CONFIG_DIR; fi
    if [[ -n "$value" ]]; then
      timeout 15s "${SERVICE_OPENCODE[@]}" service set env "$name" "$value" >/dev/null
    fi
  done
  timeout 45s "${SERVICE_OPENCODE[@]}" service start >/dev/null
fi
systemctl --user restart opencode-web-client.service

if [[ "$SELFTEST" != 0 ]]; then
  SELFTEST_ARGS=()
  if [[ "$RAG_DISABLED" == false ]]; then
    SELFTEST_ARGS+=(--rag-enabled)
  fi
  "$PYTHON3" "$ROOT/scripts/install-selftest.py" "${SELFTEST_ARGS[@]}"
fi

echo "Installed. Start OpenCode with: custom-opencode"
if [[ "$RAG_DISABLED" == false ]]; then
  echo "RAG MCP: enabled ($RAG_ROOT)"
else
  echo "RAG MCP: disabled; set MCP_RAG_ROOT/MCP_RAG_BIN and rerun install/update"
fi
