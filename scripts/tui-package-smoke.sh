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
import os, pty, re, select, struct, subprocess, sys, termios, time, fcntl
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

def drain(timeout=0.10):
    global buffer
    ready, _, _ = select.select([master], [], [], timeout)
    if not ready:
        return False
    try:
        chunk = os.read(master, 4096)
    except OSError:
        return False
    if not chunk:
        return False
    buffer += chunk
    return True

def wait_for(needle, seconds):
    end = time.time() + seconds
    while time.time() < end:
        drain(0.10)
        if needle in buffer:
            return True
        if proc.poll() is not None:
            break
    drain(0)
    return needle in buffer

def press_enter():
    # OpenTUI V2 enables its key parser/Kitty compatibility layer. A bare CR
    # is ignored by the headless PTY used in Actions even though a real
    # terminal reports Enter correctly. Send canonical CSI-u first and retain
    # CR as a legacy fallback so the smoke exercises the command, not the PTY.
    for sequence in (b'\x1b[13u', b'\r'):
        os.write(master, sequence)
        if wait_for(b'Select Model', 0.8):
            return True
    return b'Select Model' in buffer

while time.time() - start < 18:
    drain(0.10)
    if not selector_requested and b'Ask anything' in buffer:
        # Exercise the actual plugin command and OpenTUI renderer. This
        # specifically catches JSX/renderer regressions in model-selector.jsx
        # that a loader-only smoke cannot see.
        os.write(master, b'/models')
        time.sleep(0.35)
        selector_requested = True
        selector_rendered = press_enter()
        if selector_rendered:
            break
    if selector_requested and b'Select Model' in buffer:
        selector_rendered = True
        break
    if proc.poll() is not None:
        break
proc.terminate()
try:
    proc.wait(timeout=2)
except Exception:
    proc.kill()
try:
    while drain(0):
        pass
except Exception:
    pass
os.close(master)
with open(capture_path, 'wb') as f:
    f.write(buffer)
with open(log_path, 'wb') as f:
    f.write(buffer)
if not selector_requested or not selector_rendered:
    clean = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', buffer).decode('utf-8', 'replace')
    print(f'--- packaged TUI diagnostic tail ({geometry}) ---', file=sys.stderr)
    print(clean[-8000:], file=sys.stderr)
    print('--- end diagnostic tail ---', file=sys.stderr)
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
