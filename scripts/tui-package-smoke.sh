#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OPENCODE2_BIN=${OPENCODE2_BIN:-}
if [[ -z "$OPENCODE2_BIN" ]]; then
  OPENCODE2_BIN=$(command -v opencode2 || true)
fi
if [[ -n "$OPENCODE2_BIN" ]]; then
  OPENCODE2_BIN=$(readlink -f "$OPENCODE2_BIN")
fi

# npm postinstall can leave the packaged placeholder behind (CI regression:
# "Exec format error ... @opencode-ai/cli/bin/opencode2.exe"), so require that the
# binary actually executes and otherwise fall back to the real platform-package
# binary that postinstall.mjs copies from.
opencode2_runs() { [[ -n "${1:-}" && -x "$1" ]] && timeout 30 "$1" --version >/dev/null 2>&1; }
if ! opencode2_runs "${OPENCODE2_BIN:-}"; then
  arch=$(uname -m)
  case "$arch" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
  esac
  platform=$(uname -s | tr '[:upper:]' '[:lower:]')
  candidates=()
  if [[ -n "${OPENCODE2_BIN:-}" ]]; then
    cli_dir=$(dirname "$(dirname "$OPENCODE2_BIN")")
    candidates+=("$cli_dir"/node_modules/@opencode-ai/cli-"$platform"-"$arch"*/bin/opencode2)
  fi
  global_root=$(npm root -g 2>/dev/null || true)
  if [[ -n "$global_root" ]]; then
    # ponytail: the glob covers baseline/musl variants; --version rejects a wrong ABI.
    candidates+=("$global_root"/@opencode-ai/cli/node_modules/@opencode-ai/cli-"$platform"-"$arch"*/bin/opencode2)
    candidates+=("$global_root"/@opencode-ai/cli-"$platform"-"$arch"*/bin/opencode2)
  fi
  resolved=""
  for candidate in "${candidates[@]}"; do
    if opencode2_runs "$candidate"; then
      resolved=$(readlink -f "$candidate")
      break
    fi
  done
  if [[ -z "$resolved" ]]; then
    echo "opencode2 is required for packaged TUI smoke (set OPENCODE2_BIN or add it to PATH)" >&2
    exit 2
  fi
  OPENCODE2_BIN="$resolved"
fi

TMP=$(mktemp -d)
trap 'HOME="$TMP/home" "$OPENCODE2_BIN" service stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
HOME_DIR="$TMP/home"
CONFIG="$HOME_DIR/.config/opencode"
export HOME="$HOME_DIR"
export XDG_CONFIG_HOME="$HOME_DIR/.config"
export XDG_DATA_HOME="$HOME_DIR/.local/share"
export XDG_STATE_HOME="$HOME_DIR/.local/state"
export XDG_CACHE_HOME="$HOME_DIR/.cache"
mkdir -p "$CONFIG/plugins/tui" "$CONFIG/prompts" "$CONFIG/themes" "$TMP/project"
mkdir -p "$HOME_DIR/.opencode/plan"
printf '%s\n' '# Packaged V2 plan fixture' '- [x] Load the native plan document' '- [ ] Keep the panel compatible' > "$HOME_DIR/.opencode/plan/fixture.md"
cp "$ROOT/config/cli.json" "$CONFIG/cli.json"
cp "$ROOT/config/AGENTS.md" "$CONFIG/AGENTS.md"
cp -a "$ROOT/config/plugins/tui/." "$CONFIG/plugins/tui/"
mv "$CONFIG/plugins/tui/tui.js" "$CONFIG/plugins/tui/production-tui.js"
cp "$ROOT/scripts/tui-keyboard-probe.jsx" "$CONFIG/plugins/tui/tui.js"
cp -a "$ROOT/config/prompts/." "$CONFIG/prompts/"
cp -a "$ROOT/config/themes/." "$CONFIG/themes/"

python3 - "$ROOT/config/opencode.json.template" "$CONFIG/opencode.json" "$CONFIG" "$ROOT" <<'PY'
import json,sys
source,target,config_dir,root=sys.argv[1:]
text=open(source,encoding='utf-8').read()
text=text.replace('__CONFIG_DIR__',config_dir)
text=text.replace('__CUSTOM_OPENCODE_ROOT__',root)
text=text.replace('__RAG_DISABLED__','true')
config=json.loads(text)
config.pop('plugins', None)
config['compaction']={'auto':True,'keep':{'tokens':4096},'buffer':2048}
config['tool_output']={'max_lines':1600,'max_bytes':48000}
kb=(((config.get('mcp') or {}).get('servers') or {}).get('kb'))
if isinstance(kb,dict): kb['codemode']=True
open(target,'w',encoding='utf-8').write(json.dumps(config,ensure_ascii=False,indent=2)+'\n')
PY

export TOKEN_PLAN_API_KEY=test
export TOKEN_PLAN_ANTHROPIC_BASE_URL=https://token-plan.example.invalid/apps/anthropic/v1
export TOKEN_PLAN_OPENAI_BASE_URL=https://token-plan.example.invalid/compatible-mode/v1
export OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
export MCP_RAG_ENABLED=0
export OPENCODE_SERVER_PASSWORD=test
export CODEX_BIN=/nonexistent/custom-opencode-codex
export BAILIAN_CLI_BIN=/nonexistent/custom-opencode-bl
export TUI_KEYBOARD_PROBE="$TMP/keyboard.json"

for geometry in 80x24 120x30 160x40; do
  capture="$TMP/tui-$geometry.typescript"
  log="$TMP/tui-$geometry.log"
  python3 - "$geometry" "$TMP/project" "$capture" "$log" "$OPENCODE2_BIN" <<'PY'
import fcntl, json, os, pty, select, struct, subprocess, sys, termios, time
geometry, project, capture_path, log_path, opencode_bin = sys.argv[1:6]
cols, rows = map(int, geometry.split('x'))
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
env = os.environ.copy()
env['TERM'] = 'xterm-256color'
proc = subprocess.Popen([opencode_bin, '--standalone'], stdin=slave, stdout=slave, stderr=slave, cwd=project, env=env, close_fds=True)
os.close(slave)
buffer = b''
deadline = time.time() + 18
while time.time() < deadline:
    ready, _, _ = select.select([master], [], [], 0.15)
    if ready:
        try:
            chunk = os.read(master, 4096)
        except OSError:
            break
        if not chunk:
            break
        buffer += chunk
        if b'Ask anything' in buffer:
            # Give async plugin setup a short window to surface loader/runtime errors.
            settle = time.time() + 1.0
            while time.time() < settle:
                ready, _, _ = select.select([master], [], [], 0.10)
                if not ready:
                    continue
                try:
                    extra = os.read(master, 4096)
                except OSError:
                    break
                if not extra:
                    break
                buffer += extra
            if geometry == '160x40':
                def settle(seconds):
                    global buffer
                    until = time.monotonic() + seconds
                    while time.monotonic() < until:
                        if select.select([master], [], [], .05)[0]:
                            buffer += os.read(master, 65536)
                os.write(master, b'\x1b')
                settle(.15)
                os.write(master, b'\x1b')
                settle(.8)
                with open(os.environ['TUI_KEYBOARD_PROBE']) as handle:
                    assert json.load(handle) == [{'sessionID':'ses_keyboard_probe','continue':False}]
                os.write(master, b'\x1bOS')  # F4 opens a real native dialog.
                settle(.5)
                os.write(master, b'\x1b')
                settle(.5)
                with open(os.environ['TUI_KEYBOARD_PROBE']) as handle:
                    assert json.load(handle) == [{'sessionID':'ses_keyboard_probe','continue':False}, 'dialog-closed']
                os.write(master, b'\x1b[15~')  # F5 injects one native location sync failure.
                recovery_deadline = time.monotonic() + 28
                recovery = None
                while time.monotonic() < recovery_deadline:
                    settle(.1)
                    with open(os.environ['TUI_KEYBOARD_PROBE']) as handle:
                        events = json.load(handle)
                    recovery = next((item for item in events if isinstance(item, dict) and 'recovery' in item), None)
                    if recovery is not None:
                        break
                assert 'location-warning-visible' in events, events
                assert recovery and recovery['recovery'] and not recovery['nativeWarning'], events
                assert recovery['elapsed'] >= 15000, recovery
                print('Native location recovery: warning shown, real 15s retry, warning cleared', flush=True)
            if geometry == '80x24':
                os.write(master, b'/panel right limits\r')
                command_deadline = time.time() + 2.0
                while time.time() < command_deadline:
                    ready, _, _ = select.select([master], [], [], 0.10)
                    if not ready:
                        continue
                    try:
                        extra = os.read(master, 4096)
                    except OSError:
                        break
                    if not extra:
                        break
                    buffer += extra
                    if 'Лимиты'.encode() in buffer:
                        break
            break
    if proc.poll() is not None:
        break
proc.terminate()
try:
    proc.wait(timeout=2)
except Exception:
    proc.kill()
try:
    while select.select([master], [], [], 0)[0]:
        extra = os.read(master, 4096)
        if not extra:
            break
        buffer += extra
except OSError:
    pass
os.close(master)
with open(capture_path, 'wb') as f:
    f.write(buffer)
with open(log_path, 'wb') as f:
    f.write(buffer)
PY
  if grep -Eqi 'SyntaxError|Failed to load.*plugin|Plugin failed|Cannot find (module|package)|Unhandled.*Error|No renderer found|useRenderer|limits-(header|panels).*error|workspace-panel.*error|panel-slash.*error|panel-submit-router.*error|panel-views.*error|panel-command.*error|model-selector.*error|effort-indicator.*error|wsl-clipboard.*error' "$capture" "$log"; then
    echo "TUI plugin/renderer loader error at $geometry" >&2
    grep -Eai 'SyntaxError|Failed to load.*plugin|Plugin failed|Cannot find (module|package)|Unhandled.*Error|No renderer found|useRenderer|limits-|workspace-panel|panel-slash|panel-submit-router|panel-views|panel-command|model-selector|effort-indicator|wsl-clipboard' "$capture" "$log" >&2 || true
    exit 1
  fi
  grep -Fq 'Ask anything' "$capture" || {
    echo "TUI did not reach the prompt at $geometry" >&2
    exit 1
  }
  if [[ "$geometry" == "80x24" ]]; then
    grep -Fq 'Лимиты' "$capture" || {
      echo "TUI did not open /panel right limits at 80x24" >&2
      exit 1
    }
  fi
done

echo "Packaged TUI smoke passed: native PTY at 80x24/120x30/160x40; Escape, dialog Escape and automatic location recovery; model selection is gated by model-selector-smoke.mjs"
