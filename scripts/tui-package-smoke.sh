#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if ! command -v opencode2 >/dev/null 2>&1; then
  echo "opencode2 is required for packaged TUI smoke" >&2
  exit 2
fi
if ! command -v script >/dev/null 2>&1; then
  echo "util-linux script(1) is required for packaged TUI smoke" >&2
  exit 2
fi

TMP=$(mktemp -d)
trap 'HOME="$TMP/home" opencode2 service stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
HOME_DIR="$TMP/home"
CONFIG="$HOME_DIR/.config/opencode"
export HOME="$HOME_DIR"
export XDG_CONFIG_HOME="$HOME_DIR/.config"
export XDG_DATA_HOME="$HOME_DIR/.local/share"
mkdir -p "$CONFIG/plugins/tui" "$CONFIG/prompts" "$CONFIG/themes" "$TMP/project"
mkdir -p "$HOME_DIR/.opencode/plan"
printf '%s\n' '# Packaged V2 plan fixture' '- [x] Load the native plan document' '- [ ] Keep the panel compatible' > "$HOME_DIR/.opencode/plan/fixture.md"
cp "$ROOT/config/cli.json" "$CONFIG/cli.json"
cp "$ROOT/config/AGENTS.md" "$CONFIG/AGENTS.md"
cp -a "$ROOT/config/plugins/tui/." "$CONFIG/plugins/tui/"
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
config['compaction']={'auto':True,'keep':{'tokens':12000},'buffer':24000}
config['tool_output']={'max_lines':1600,'max_bytes':48000}
kb=(((config.get('mcp') or {}).get('servers') or {}).get('kb'))
if isinstance(kb,dict): kb['codemode']=True
open(target,'w',encoding='utf-8').write(json.dumps(config,ensure_ascii=False,indent=2)+'\n')
PY

export HOME="$HOME_DIR"
export TOKEN_PLAN_API_KEY=test
export TOKEN_PLAN_ANTHROPIC_BASE_URL=https://token-plan.example.invalid/apps/anthropic/v1
export TOKEN_PLAN_OPENAI_BASE_URL=https://token-plan.example.invalid/compatible-mode/v1
export OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
export MCP_RAG_ENABLED=0
export OPENCODE_SERVER_PASSWORD=test
export CODEX_BIN=/nonexistent/custom-opencode-codex
export BAILIAN_CLI_BIN=/nonexistent/custom-opencode-bl

for geometry in 80x24 120x30 160x40; do
  cols=${geometry%x*}
  rows=${geometry#*x}
  capture="$TMP/tui-$geometry.typescript"
  log="$TMP/tui-$geometry.log"
  python3 - "$geometry" "$TMP/project" "$capture" "$log" <<'PY'
import fcntl, os, pty, select, struct, subprocess, sys, termios, time
geometry, project, capture_path, log_path = sys.argv[1:5]
cols, rows = map(int, geometry.split('x'))
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
start = time.time()
env = os.environ.copy()
env['TERM'] = 'xterm-256color'
proc = subprocess.Popen(['opencode2', '--standalone'], stdin=slave, stdout=slave, stderr=slave, cwd=project, env=env, close_fds=True)
os.close(slave)
buffer = b''
selector_requested = False
selector_rendered = False
while time.time() - start < 18:
    ready, _, _ = select.select([master], [], [], 0.10)
    if not ready:
        if proc.poll() is not None:
            break
        continue
    try:
        chunk = os.read(master, 2048)
    except OSError:
        break
    if not chunk:
        if proc.poll() is not None:
            break
        continue
    buffer += chunk
    if not selector_requested and b'Ask anything' in buffer:
        # Exercise the actual plugin command and OpenTUI renderer. This
        # specifically catches JSX/renderer regressions in model-selector.jsx
        # that a loader-only smoke cannot see.
        os.write(master, b'/models')
        time.sleep(0.15)
        os.write(master, b'\r')
        selector_requested = True
    if selector_requested and b'Select Model' in buffer:
        selector_rendered = True
        break
proc.terminate()
try:
    proc.wait(timeout=2)
except Exception:
    proc.kill()
os.close(master)
with open(capture_path, 'wb') as f:
    f.write(buffer)
with open(log_path, 'wb') as f:
    f.write(buffer)
if not selector_requested:
    raise SystemExit('TUI did not reach the prompt')
if not selector_rendered:
    raise SystemExit('TUI model selector did not render after /models')
PY
  if grep -Eqi 'SyntaxError|Failed to load.*plugin|Plugin failed|Cannot find (module|package)|Unhandled.*Error|No renderer found|useRenderer|limits-(header|panels).*error|workspace-panel.*error|panel-slash.*error|panel-submit-router.*error|panel-views.*error|panel-command.*error|prompt-history.*error|model-selector.*error|effort-indicator.*error|wsl-clipboard.*error' "$capture" "$log"; then
    echo "TUI plugin/renderer error at $geometry" >&2
    grep -Eai 'SyntaxError|Failed to load.*plugin|Plugin failed|Cannot find (module|package)|Unhandled.*Error|No renderer found|useRenderer|limits-|workspace-panel|panel-slash|panel-submit-router|panel-views|panel-command|prompt-history|model-selector|effort-indicator|wsl-clipboard' "$capture" "$log" >&2 || true
    exit 1
  fi
  grep -Fq 'Ask anything' "$capture" || {
    echo "TUI did not reach the prompt at $geometry" >&2
    exit 1
  }
  grep -Fq 'Select Model' "$capture" || {
    echo "TUI /models did not render the model selector at $geometry" >&2
    exit 1
  }
done

echo "Packaged TUI smoke passed: opencode2 loader + real /models renderer + local panel router + four-zone panels at 80x24/120x30/160x40"