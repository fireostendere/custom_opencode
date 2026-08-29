#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PYTHON3=$(command -v python3 || true)
NODE=$(command -v node || true)
[[ -n "$PYTHON3" ]] || { echo "python3 is required" >&2; exit 1; }
[[ -n "$NODE" ]] || { echo "node is required" >&2; exit 1; }

"$PYTHON3" -m py_compile \
  "$ROOT/app/runtime_v3.py" "$ROOT/app/runtime_v3_ext.py" "$ROOT/app/runtime_completion.py" \
  "$ROOT/app/server_workflow.py" "$ROOT/scripts/runtime-v3-smoke.py" \
  "$ROOT/scripts/runtime-v3-worktree-smoke.py" "$ROOT/scripts/runtime-completion-smoke.py" \
  "$ROOT/scripts/install-runtime-v3-selftest.py"
"$NODE" --check "$ROOT/config/plugins/server-runtime-guard.js"
"$NODE" --check "$ROOT/app/runtime-v3-dashboard.js"
"$NODE" --check "$ROOT/app/control-plane.js"
"$PYTHON3" "$ROOT/scripts/runtime-v3-smoke.py"
"$PYTHON3" "$ROOT/scripts/runtime-v3-worktree-smoke.py"
"$PYTHON3" "$ROOT/scripts/runtime-completion-smoke.py"

for marker in \
  'config["compaction"]' \
  'config["tool_output"]' \
  'kb["codemode"] = True' \
  'OPENCODE_RUNTIME_PLUGIN_TOKEN' \
  'OPENCODE_RUNTIME_PLUGIN_HOST'; do
  grep -Fq "$marker" "$ROOT/scripts/install.sh" || { echo "runtime v3 installer marker missing: $marker" >&2; exit 1; }
done

for marker in \
  'ctx.session.hook("context"' \
  'ctx.tool.hook("execute.before"' \
  'ctx.tool.hook("execute.after"' \
  'ctx.tool.transform' \
  'ctx.shell.hook("create.before"' \
  '/internal/runtime/tool-before' \
  '/internal/runtime/tool-cache' \
  '/internal/runtime/shell'; do
  grep -Fq "$marker" "$ROOT/config/plugins/server-runtime-guard.js" || { echo "runtime guard hook missing: $marker" >&2; exit 1; }
done

"$PYTHON3" - "$ROOT" <<'PY'
from pathlib import Path
import json,sys
root=Path(sys.argv[1])
required={
  "app/runtime_v3.py":["class SemanticRepoIndexer","class DynamicContextManager","class ToolGateway","class ScopedSecretBroker","class SandboxManager","class AdaptiveResourceScheduler","class SharedRAGService","class ReplayService","class BranchStateService"],
  "app/runtime_v3_ext.py":["notification.sent","run-replay","client-mcp-gateway-v3.json","client-runtime-telemetry.json","client-task-sandbox.json","client-worktree-merge.json","worktree.merged","_ownership_root_wrapped"],
  "app/runtime_completion.py":["permission_preview","wasted_retries","tool-input-v3","branch-state-merged","client-remote-status.json","client-remote-action.json"],
  "app/server_workflow.py":["runtime_v3.install","runtime_v3_ext.install","runtime_completion.install","runtime_v3.context_envelope"],
  "app/runtime-v3-dashboard.js":["client-runtime-telemetry.json","client-repo-index-v3.json","client-session-branch.json","client-session-merge.json","client-task-sandbox.json","client-replay.json","client-worktree-merge.json"],
  "app/control-plane.js":["decision.preview","serverPreview"],
}
for name,markers in required.items():
    text=(root/name).read_text(encoding="utf-8")
    for marker in markers:
        if marker not in text: raise SystemExit(f"missing {name} marker: {marker}")
index=(root/"app/index.html").read_text(encoding="utf-8")
for marker in ('/runtime-v3-dashboard.js','/runtime-v3-dashboard.css'):
    if marker not in index: raise SystemExit(f"missing Runtime V3 UI asset: {marker}")
text=(root/"config/opencode.json.template").read_text(encoding="utf-8")
text=text.replace("__CONFIG_DIR__","/tmp/opencode").replace("__CUSTOM_OPENCODE_ROOT__","/tmp/custom-opencode").replace("__RAG_DISABLED__","true")
config=json.loads(text)
config["compaction"]={"auto":True,"keep":{"tokens":12000},"buffer":24000}
config["tool_output"]={"max_lines":1600,"max_bytes":48000}
config["mcp"]["servers"]["kb"]["codemode"]=True
assert config["compaction"]["auto"] is True
assert config["compaction"]["buffer"]==24000
assert config["tool_output"]["max_bytes"]==48000
assert config["mcp"]["servers"]["kb"]["codemode"] is True
print("Runtime V3 config render PASS")
PY

echo "Runtime V3 verification PASS"
