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
mkdir -p "$CONFIG/plugins/tui" "$CONFIG/prompts" "$CONFIG/themes" "$TMP/project"
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

# Smoke the real packaged loader at several terminal sizes. A timeout is the
# normal exit: this test only needs the initial reactive render, not a model run.
for geometry in 80x24 120x30 160x40; do
  cols=${geometry%x*}
  rows=${geometry#*x}
  capture="$TMP/tui-$geometry.typescript"
  log="$TMP/tui-$geometry.log"
  set +e
  timeout 9s script -qefc "cd '$TMP/project'; stty cols $cols rows $rows; TERM=xterm-256color opencode2" "$capture" >"$log" 2>&1
  status=$?
  set -e
  if [[ $status -ne 0 && $status -ne 124 ]]; then
    echo "opencode2 TUI exited unexpectedly at $geometry: $status" >&2
    cat "$log" >&2
    exit 1
  fi
  if grep -Eqi 'SyntaxError|Failed to load.*plugin|Cannot find (module|package)|Unhandled.*Error|limits-(header|panels).*error|model-selector.*error' "$capture" "$log"; then
    echo "TUI plugin loader error at $geometry" >&2
    grep -Eai 'SyntaxError|Failed to load.*plugin|Cannot find (module|package)|Unhandled.*Error|limits-|model-selector' "$capture" "$log" >&2 || true
    exit 1
  fi
  # Header is mounted in the app slot on the first frame. With CLI probes
  # intentionally unavailable it must still render the fallback labels.
  if ! grep -aq 'ChatGPT:' "$capture" || ! grep -aq 'Alibaba:' "$capture"; then
    echo "custom TUI header did not render at $geometry" >&2
    tail -c 12000 "$capture" >&2 || true
    exit 1
  fi
done

echo "Packaged TUI smoke passed: opencode2 loader + reactive header at 80x24/120x30/160x40"
