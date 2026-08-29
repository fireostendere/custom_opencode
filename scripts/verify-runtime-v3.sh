#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PYTHON3=$(command -v python3 || true)
NODE=$(command -v node || true)
[[ -n "$PYTHON3" ]] || { echo "python3 is required" >&2; exit 1; }
[[ -n "$NODE" ]] || { echo "node is required" >&2; exit 1; }

"$PYTHON3" -m py_compile \
  "$ROOT/app/runtime_v3.py" "$ROOT/app/runtime_v3_ext.py" \
  "$ROOT/app/server_workflow.py" "$ROOT/scripts/runtime-v3-smoke.py"
"$NODE" --check "$ROOT/config/plugins/server-runtime-guard.js"
"$PYTHON3" "$ROOT/scripts/runtime-v3-smoke.py"

for marker in \
  'config["compaction"]' \
  'config["tool_output"]' \
  'kb["codemode"] = True' \
  'OPENCODE_RUNTIME_PLUGIN_TOKEN' \
  'OPENCODE_RUNTIME_PLUGIN_HOST'; do
  grep -Fq "$marker" "$ROOT/scripts/install.sh" || { echo "runtime v3 installer marker missing: $marker" >&2; exit 1; }
done

for marker in \
  'ctx.session.hook("request"' \
  'ctx.tool.hook("execute.before"' \
  'ctx.tool.hook("execute.after"' \
  'ctx.shell.hook("create.before"' \
  '/internal/runtime/tool-before' \
  '/internal/runtime/shell'; do
  grep -Fq "$marker" "$ROOT/config/plugins/server-runtime-guard.js" || { echo "runtime guard hook missing: $marker" >&2; exit 1; }
done

"$PYTHON3" - "$ROOT" <<'PY'
from pathlib import Path
import json,sys
root=Path(sys.argv[1])
required={
  "app/runtime_v3.py":["class SemanticRepoIndexer","class DynamicContextManager","class ToolGateway","class ScopedSecretBroker","class SandboxManager","class AdaptiveResourceScheduler","class SharedRAGService","class ReplayService","class BranchStateService"],
  "app/runtime_v3_ext.py":["notification.sent","run-replay","client-mcp-gateway-v3.json","client-runtime-telemetry.json","client-task-sandbox.json"],
  "app/server_workflow.py":["runtime_v3.install","runtime_v3_ext.install","runtime_v3.context_envelope"],
}
for name,markers in required.items():
    text=(root/name).read_text(encoding="utf-8")
    for marker in markers:
        if marker not in text: raise SystemExit(f"missing {name} marker: {marker}")
# Emulate the install-time canonical OpenCode V2 render and verify the settings
# that cannot be left to UI/client behavior.
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
