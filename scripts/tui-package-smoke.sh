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

# The GitHub Actions PTY is intentionally a dumb terminal and does not emit
# OpenTUI selection key events reliably. Inject a test-only driver into the
# isolated copied bundle and dispatch the production model.list command through
# OpenCode's native keymap. This still exercises the real command registration,
# model catalog path, dialog.select renderer and JSX runtime on the pinned V2.
cat > "$CONFIG/plugins/tui/package-smoke-driver.js" <<'JS'
import { Plugin } from "@opencode-ai/plugin/tui"
export default Plugin.define({
  id: "custom.package-smoke-driver",
  setup(context) {
    let attempts = 0
    const timer = setInterval(() => {
      attempts += 1
      try {
        const handled = context.keymap.dispatch("model.list")
        if (handled !== false || attempts >= 30) clearInterval(timer)
      } catch {
        if (attempts >= 30) clearInterval(timer)
      }
    }, 100)
    return () => clearInterval(timer)
  },
})
JS
python3 - "$CONFIG/plugins/tui/tui.js" <<'PY'
from pathlib import Path
import sys
path=Path(sys.argv[1])
text=path.read_text(encoding='utf-8')
needle='import wslClipboard from "./wsl-clipboard.jsx"\n'
if needle not in text: raise SystemExit('tui bundle import anchor missing')
text=text.replace(needle, needle+'import packageSmokeDriver from "./package-smoke-driver.js"\n', 1)
needle='  wslClipboard,\n]'
if needle not in text: raise SystemExit('tui bundle plugin anchor missing')
text=text.replace(needle, '  wslClipboard,\n  packageSmokeDriver,\n]', 1)
path.write_text(text,encoding='utf-8')
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

while time.time() - start < 18:
    drain(0.10)
    if b'Ask anything' in buffer and b'Select Model' in buffer:
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
if b'Ask anything' not in buffer or b'Select Model' not in buffer:
    clean = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', buffer).decode('utf-8', 'replace')
    print(f'--- packaged TUI diagnostic tail ({geometry}) ---', file=sys.stderr)
    print(clean[-8000:], file=sys.stderr)
    print('--- end diagnostic tail ---', file=sys.stderr)
if b'Ask anything' not in buffer:
    raise SystemExit('TUI did not reach the prompt')
if b'Select Model' not in buffer:
    raise SystemExit('TUI model selector did not render through native model.list dispatch')
PY
  if grep -Eqi 'SyntaxError|Failed to load.*plugin|Plugin failed|Cannot find (module|package)|Unhandled.*Error|No renderer found|useRenderer|Failed to load model list|No models available|limits-(header|panels).*error|workspace-panel.*error|panel-slash.*error|panel-submit-router.*error|panel-views.*error|panel-command.*error|prompt-history.*error|model-selector.*error|effort-indicator.*error|wsl-clipboard.*error' "$capture" "$log"; then
    echo "TUI plugin/model-selector/renderer error at $geometry" >&2
    grep -Eai 'SyntaxError|Failed to load.*plugin|Plugin failed|Cannot find (module|package)|Unhandled.*Error|No renderer found|useRenderer|Failed to load model list|No models available|limits-|workspace-panel|panel-slash|panel-submit-router|panel-views|panel-command|prompt-history|model-selector|effort-indicator|wsl-clipboard' "$capture" "$log" >&2 || true
    exit 1
  fi
  grep -Fq 'Ask anything' "$capture" || {
    echo "TUI did not reach the prompt at $geometry" >&2
    exit 1
  }
  grep -Fq 'Select Model' "$capture" || {
    echo "TUI native model.list did not render the model selector at $geometry" >&2
    exit 1
  }
done

echo "Packaged TUI smoke passed: opencode2 loader + native model.list dispatch + real model selector renderer + local panel router + four-zone panels at 80x24/120x30/160x40"
