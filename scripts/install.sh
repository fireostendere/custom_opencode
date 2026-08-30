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

RAG_MODE=${MCP_RAG_ENABLED:-auto}
case "$RAG_MODE" in
  0|1|auto) ;;
  *)
    echo "MCP_RAG_ENABLED must be one of: 0, 1, auto" >&2
    exit 1
    ;;
esac

RAG_ROOT=""
RAG_BIN=""
RAG_DISABLED=true
if [[ "$RAG_MODE" != 0 ]]; then
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
  if [[ -n "$RAG_ROOT" && -n "$RAG_BIN" && -x "$RAG_BIN" ]]; then
    RAG_DISABLED=false
  elif [[ "$RAG_MODE" == 1 ]]; then
    echo "MCP_RAG_ENABLED=1 but no usable RAG checkout/executable was found" >&2
    echo "Set MCP_RAG_ROOT and MCP_RAG_BIN, or set MCP_RAG_ENABLED=0 to disable RAG intentionally." >&2
    exit 1
  fi
fi

if [[ "$SELFTEST" != 0 ]]; then
  echo "==> Pre-install verification"
  "$PYTHON3" -m py_compile \
    "$ROOT/scripts/install-selftest.py" \
    "$ROOT/scripts/install-runtime-v3-selftest.py" \
    "$ROOT/scripts/rag-live-regression.py" \
    "$ROOT/scripts/runtime-invariants-smoke.py" \
    "$ROOT/scripts/model-routing-effort-smoke.py" \
    "$ROOT/scripts/pin-orchestrated-recent.py" \
    "$ROOT/app/runtime_invariants.py" \
    "$ROOT/app/model_registry.py"
  "$ROOT/scripts/verify.sh"
  "$ROOT/scripts/verify-runtime-v3.sh"
  "$PYTHON3" "$ROOT/scripts/model-routing-effort-smoke.py"
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
  install -d "$CONFIG_DIR/plugins" "$CONFIG_DIR/plugins/tui" "$CONFIG_DIR/prompts" "$CONFIG_DIR/themes"
  if [[ -f "$CONFIG_DIR/opencode.json" ]]; then
    cp -p "$CONFIG_DIR/opencode.json" "$CONFIG_DIR/opencode.json.backup.$(date +%Y%m%d%H%M%S)"
  fi
  install -m 0644 "$ROOT/config/AGENTS.md" "$CONFIG_DIR/AGENTS.md"
  install -m 0644 "$ROOT/config/cli.json" "$CONFIG_DIR/cli.json"
  install -m 0644 "$ROOT/config/events.js" "$CONFIG_DIR/events.js"
  install -m 0644 "$ROOT/config/prompts/"* "$CONFIG_DIR/prompts/"
  install -m 0644 "$ROOT"/config/plugins/*.js "$CONFIG_DIR/plugins/"
  # TUI plugins renamed from .js to .jsx in newer revisions; the loader
  # auto-discovers plugins/tui, so stale copies would load as broken plugins.
  rm -f "$CONFIG_DIR"/plugins/tui/limits-header.js \
        "$CONFIG_DIR"/plugins/tui/limits-panels.js \
        "$CONFIG_DIR"/plugins/tui/model-selector.js \
        "$CONFIG_DIR"/plugins/tui/limits-helper.js
  if compgen -G "$ROOT/config/plugins/tui/*" > /dev/null; then
    while IFS= read -r -d '' rel; do
      install -D -m 0644 "$ROOT/config/plugins/tui/$rel" "$CONFIG_DIR/plugins/tui/$rel"
    done < <(cd "$ROOT/config/plugins/tui" && find . -type f -print0)
  fi
  install -m 0644 "$ROOT"/config/themes/*.json "$CONFIG_DIR/themes/"
  "$PYTHON3" - "$ROOT/config/opencode.json.template" "$CONFIG_DIR/opencode.json" "$CONFIG_DIR" "$ROOT" "$RAG_DISABLED" <<'PY'
import json, sys
source, target, config_dir, root, rag_disabled = sys.argv[1:]
text = open(source, encoding="utf-8").read()
text = text.replace("__CONFIG_DIR__", config_dir)
text = text.replace("__CUSTOM_OPENCODE_ROOT__", root)
text = text.replace("__RAG_DISABLED__", rag_disabled)
config = json.loads(text)
# Runtime V3 relies on native durable compaction and Code Mode. Code Mode keeps
# MCP schemas out of the provider tool list until the namespace is actually used.
config["compaction"] = {"auto": True, "keep": {"tokens": 12000}, "buffer": 24000}
config["tool_output"] = {"max_lines": 1600, "max_bytes": 48000}
kb = (((config.get("mcp") or {}).get("servers") or {}).get("kb"))
if isinstance(kb, dict):
    kb["codemode"] = True
with open(target, "w", encoding="utf-8") as handle:
    json.dump(config, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
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
"$PYTHON3" "$ROOT/scripts/pin-orchestrated-recent.py" >/dev/null 2>&1 || true
if command -v opencode2 >/dev/null 2>&1; then
  exec env -u OPENCODE_CONFIG_DIR opencode2 "\$@"
fi
if [[ -z "\${OPENCODE_CONFIG_DIR:-}" ]]; then
  unset OPENCODE_CONFIG_DIR
fi
exec opencode "\$@"
EOF
chmod 0755 "$BIN_DIR/custom-opencode"

ln -sfn "$ROOT/scripts/update.sh" "$BIN_DIR/custom-opencode-update"

systemctl --user daemon-reload
systemctl --user enable --now opencode-web-client.service
if command -v opencode2 >/dev/null 2>&1; then
  # The shared V2 service is long-lived and does not inherit variables from a
  # later custom-opencode client. Persist only variables needed by providers and
  # server-runtime plugins; arbitrary agent shells are scrubbed by the guard.
  SERVICE_OPENCODE=(env -u OPENCODE_CONFIG_DIR opencode2)
  SERVICE_ENV=(
    OPENCODE_CONFIG_DIR TOKEN_PLAN_API_KEY TOKEN_PLAN_ANTHROPIC_BASE_URL
    TOKEN_PLAN_OPENAI_BASE_URL TOKEN_PLAN_PROBE_MODEL OLLAMA_BASE_URL
    BAILIAN_CONFIG_PATH QWEN_QUOTA_PROBE_ENABLED OPENCODE_WEB_PORT
    OPENCODE_SERVER_PASSWORD OPENCODE_RUNTIME_PLUGIN_TOKEN
    OPENCODE_RUNTIME_PLUGIN_HOST OPENCODE_RUNTIME_PLUGIN_TIMEOUT_MS
    OPENCODE_SECRET_PREFIXES OPENCODE_PLANNER_MODEL OPENCODE_BUILDER_MODEL
    OPENCODE_READER_MODEL OPENCODE_REVIEW_MODEL OPENCODE_LONG_HORIZON_MODEL
    OPENCODE_ORCHESTRATED_MODEL
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
  "$ROOT/scripts/cli-wrapper-selftest.sh" "$BIN_DIR/custom-opencode"
  SELFTEST_ARGS=()
  if [[ "$RAG_DISABLED" == false ]]; then
    SELFTEST_ARGS+=(--rag-enabled)
  fi
  "$PYTHON3" "$ROOT/scripts/install-selftest.py" "${SELFTEST_ARGS[@]}"
  "$PYTHON3" "$ROOT/scripts/install-runtime-v3-selftest.py"
  "$PYTHON3" "$ROOT/scripts/runtime-invariants-smoke.py"
  "$PYTHON3" "$ROOT/scripts/model-routing-effort-smoke.py"
  if [[ "$RAG_DISABLED" == false ]]; then
    echo "==> Live RAG retrieval regression (zero LLM tokens)"
    "$PYTHON3" "$ROOT/scripts/rag-live-regression.py"
  fi
fi

echo "Installed. Start OpenCode with: custom-opencode"
if [[ "$RAG_DISABLED" == false ]]; then
  echo "RAG MCP: enabled ($RAG_ROOT)"
elif [[ "$RAG_MODE" == 0 ]]; then
  echo "RAG MCP: intentionally disabled (MCP_RAG_ENABLED=0)"
else
  echo "RAG MCP: disabled; set MCP_RAG_ENABLED=1 plus MCP_RAG_ROOT/MCP_RAG_BIN, then rerun install/update"
fi
