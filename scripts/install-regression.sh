#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
COPY="$TMP/custom-opencode"
HOME_DIR="$TMP/home"
FAKE_BIN="$TMP/bin"
LOG="$TMP/commands.log"
mkdir -p "$COPY" "$HOME_DIR" "$FAKE_BIN" "$TMP/projects"
cp -a "$ROOT/." "$COPY/"
rm -f "$COPY/.env"

cat >"$COPY/.env" <<EOF
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=test
OPENCODE_WEB_HOST=localhost
OPENCODE_WEB_PORT=4098
OPENCODE_WEB_ALLOW_LOCAL=0
OPENCODE_SCRATCH_DIRECTORY=$HOME_DIR/scratch
OPENCODE_PROJECT_ROOTS=$TMP/projects
CUSTOM_OPENCODE_FEATURE_STATE=$HOME_DIR/.local/state/custom-opencode/web-features.json
CUSTOM_OPENCODE_RUNTIME_DB=$HOME_DIR/.local/state/custom-opencode/runtime-v2.sqlite3
OPENCODE_PERMISSION_POLICY=workspace
OPENCODE_PERMISSION_AUDIT=1
OPENCODE_BACKEND_URL=http://localhost:9
OPENCODE_BACKEND_USERNAME=opencode
OPENCODE_BACKEND_PASSWORD=test
OPENCODE_RUNTIME_PLUGIN_HOST=127.0.0.1
OPENCODE_RUNTIME_PLUGIN_TIMEOUT_MS=1800
MCP_RAG_ENABLED=0
INSTALL_OPENCODE_CONFIG=1
CUSTOM_OPENCODE_INSTALL_SELFTEST=0
TOKEN_PLAN_API_KEY=CHANGE_ME
TOKEN_PLAN_ANTHROPIC_BASE_URL=https://token-plan.example.invalid/apps/anthropic/v1
TOKEN_PLAN_OPENAI_BASE_URL=https://token-plan.example.invalid/compatible-mode/v1
TOKEN_PLAN_PROBE_MODEL=qwen3.8-max
QWEN_QUOTA_PROBE_ENABLED=0
OLLAMA_BASE_URL=http://localhost:11434/v1
OPENCODE_LOCAL_AUTO_START=0
OPENCODE_LOCAL_PROVIDER=ollama
EOF
chmod 0600 "$COPY/.env"

cat >"$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"${CUSTOM_OPENCODE_REGRESSION_LOG:?}"
exit 0
EOF
chmod +x "$FAKE_BIN/systemctl"

# Seed files left by older TUI revisions. A fresh install/update must remove
# renamed top-level copies instead of allowing the loader to discover both.
mkdir -p "$HOME_DIR/.config/opencode/plugins/tui"
printf 'stale\n' >"$HOME_DIR/.config/opencode/plugins/tui/limits-header.js"
printf 'stale\n' >"$HOME_DIR/.config/opencode/plugins/tui/limits-header.jsx"
printf 'stale\n' >"$HOME_DIR/.config/opencode/plugins/tui/limits-panels.js"
printf 'stale\n' >"$HOME_DIR/.config/opencode/plugins/tui/model-selector.js"
printf 'stale\n' >"$HOME_DIR/.config/opencode/plugins/tui/limits-helper.js"

# Fresh install: no real OpenCode service, model call or systemd user manager.
CUSTOM_OPENCODE_REGRESSION_LOG="$LOG" HOME="$HOME_DIR" PATH="$FAKE_BIN:$PATH" \
  bash "$COPY/scripts/install.sh" >"$TMP/install.out"

CONFIG="$HOME_DIR/.config/opencode/opencode.json"
SERVICE="$HOME_DIR/.config/systemd/user/opencode-web-client.service"
WRAPPER="$HOME_DIR/.local/bin/custom-opencode"
UPDATER="$HOME_DIR/.local/bin/custom-opencode-update"
RUNTIME_GUARD="$HOME_DIR/.config/opencode/plugins/server-runtime-guard.js"
TUI_DIR="$HOME_DIR/.config/opencode/plugins/tui"
[[ -f "$CONFIG" ]] || { echo "fresh install did not render config" >&2; exit 1; }
[[ -f "$SERVICE" ]] || { echo "fresh install did not render systemd unit" >&2; exit 1; }
[[ -x "$WRAPPER" ]] || { echo "fresh install did not create executable wrapper" >&2; exit 1; }
[[ -L "$UPDATER" ]] || { echo "fresh install did not create updater symlink" >&2; exit 1; }
[[ -f "$RUNTIME_GUARD" ]] || { echo "fresh install did not install runtime guard plugin" >&2; exit 1; }
grep -Fq "$COPY/app/server_workflow.py" "$SERVICE"
grep -Fq 'systemctl --user enable --now opencode-web-client.service' "$LOG"
grep -Fq 'systemctl --user restart opencode-web-client.service' "$LOG"

for stale in limits-header.js limits-header.jsx limits-panels.js model-selector.js limits-helper.js; do
  [[ ! -e "$TUI_DIR/$stale" ]] || { echo "stale TUI plugin survived install: $stale" >&2; exit 1; }
done
python3 - "$COPY/config/plugins/tui" "$TUI_DIR" <<'PY'
from pathlib import Path
import sys
source,target=map(Path,sys.argv[1:])
def files(root):
    return sorted(str(path.relative_to(root)) for path in root.rglob('*') if path.is_file())
expected=files(source)
actual=files(target)
assert actual == expected, (expected,actual)
for rel in expected:
    assert (source/rel).read_bytes() == (target/rel).read_bytes(), rel
print('TUI install tree matches source exactly:', ', '.join(expected))
PY

python3 - "$CONFIG" "$COPY" <<'PY'
import json, sys
from pathlib import Path
path, root = map(Path, sys.argv[1:])
text = path.read_text(encoding='utf-8')
for marker in ('__CONFIG_DIR__','__CUSTOM_OPENCODE_ROOT__','__RAG_DISABLED__'):
    assert marker not in text, marker
config = json.loads(text)
kb = ((config.get('mcp') or {}).get('servers') or {}).get('kb') or {}
assert kb.get('disabled') is True
assert kb.get('codemode') is True
assert config.get('model') == 'bailian-cli/qwen3.8-max'
assert config.get('compaction') == {'auto': True, 'keep': {'tokens': 12000}, 'buffer': 24000}
assert config.get('tool_output') == {'max_lines': 1600, 'max_bytes': 48000}
assert str(root / 'scripts' / 'rag-mcp.sh') in (kb.get('command') or [])
PY

grep -Fq 'ctx.tool.hook("execute.before"' "$RUNTIME_GUARD"
grep -Fq '/internal/runtime/context' "$RUNTIME_GUARD"

# Update regression: use a fake git shim so the script proves its exact
# origin/main fast-forward contract without touching the checked-out branch.
REAL_GIT=$(command -v git)
cat >"$FAKE_BIN/git" <<EOF
#!/usr/bin/env bash
printf 'git %s\\n' "\$*" >>"\${CUSTOM_OPENCODE_REGRESSION_LOG:?}"
case "\${1:-}" in
  rev-parse)
    printf '%s\\n' '$COPY'
    exit 0
    ;;
  fetch|merge)
    exit 0
    ;;
esac
exec '$REAL_GIT' "\$@"
EOF
chmod +x "$FAKE_BIN/git"

: >"$LOG"
CUSTOM_OPENCODE_REGRESSION_LOG="$LOG" HOME="$HOME_DIR" PATH="$FAKE_BIN:$PATH" \
  bash "$COPY/scripts/update.sh" >"$TMP/update.out"
grep -Fxq 'git fetch --prune origin main' "$LOG"
grep -Fxq 'git merge --ff-only FETCH_HEAD' "$LOG"
grep -Fq 'systemctl --user restart opencode-web-client.service' "$LOG"
grep -Fq 'Updated from origin/main' "$TMP/update.out"

# The update must preserve the V3 render and exact TUI installation path.
python3 - "$CONFIG" <<'PY'
import json,sys
config=json.load(open(sys.argv[1],encoding='utf-8'))
assert config['mcp']['servers']['kb']['codemode'] is True
assert config['compaction']['auto'] is True
assert config['tool_output']['max_bytes'] == 48000
PY
[[ -f "$RUNTIME_GUARD" ]]
python3 - "$COPY/config/plugins/tui" "$TUI_DIR" <<'PY'
from pathlib import Path
import sys
source,target=map(Path,sys.argv[1:])
def files(root): return sorted(str(path.relative_to(root)) for path in root.rglob('*') if path.is_file())
assert files(source) == files(target)
for rel in files(source): assert (source/rel).read_bytes() == (target/rel).read_bytes(), rel
PY

echo "Install/update regression passed: isolated V3 render + exact TUI tree + Code Mode/compaction + pinned origin/main updater"
