#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PYTHON3=$(command -v python3 || true)
NODE=$(command -v node || true)
if [[ -z "$PYTHON3" ]]; then echo "python3 is required" >&2; exit 1; fi
if [[ -z "$NODE" ]]; then echo "node is required" >&2; exit 1; fi

"$PYTHON3" -m py_compile "$ROOT/app/server.py"

WORKSPACE_TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$WORKSPACE_TEST_ROOT"' EXIT
OPENCODE_SERVER_PASSWORD=test \
OPENCODE_BACKEND_URL=http://localhost:9 \
OPENCODE_BACKEND_PASSWORD=test \
OPENCODE_SCRATCH_DIRECTORY="$WORKSPACE_TEST_ROOT/scratch" \
"$PYTHON3" - "$ROOT/app/server.py" <<'PY'
import importlib.util
import json
import os
import sys

spec = importlib.util.spec_from_file_location("custom_opencode_server", sys.argv[1])
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
workspace = server.allocate_scratch_directory()
assert workspace.startswith(str(server.SCRATCH_ROOT) + os.sep)
assert server.is_scratch_path(workspace)
sessions = {"data": [
    {"id": "root", "location": {"directory": workspace}},
    {"id": "child", "parentID": "root", "location": {"directory": workspace}},
]}
filtered = json.loads(server.transform_json_response("GET", "/api/session", json.dumps(sessions).encode()))
assert [session["id"] for session in filtered["data"]] == ["root"]
assert filtered["data"][0]["projectID"] == server.SCRATCH_PROJECT_ID
projects = json.loads(server.transform_json_response("GET", "/api/project", b"[]"))
assert projects[-1]["id"] == server.SCRATCH_PROJECT_ID
server.cleanup_scratch_directory(workspace)
assert not os.path.exists(workspace)
assert server.SCRATCH_ROOT.is_dir()
print("Session workspace self-check passed")
PY
rm -rf "$WORKSPACE_TEST_ROOT"
trap - EXIT

for file in "$ROOT/app/"*.js "$ROOT/config/events.js" "$ROOT/config/plugins/"*.js; do
  "$NODE" --check "$file"
done
for file in "$ROOT/scripts/"*.sh; do
  bash -n "$file"
done

"$PYTHON3" - "$ROOT" <<'PY'
from pathlib import Path
import json, re, sys

root = Path(sys.argv[1])
bad = []

# Web client must remain modular; do not regress to the old 70+ KB inline monolith.
index = (root / "app/index.html").read_text(encoding="utf-8")
required_web = ["styles.css", "api.js", "markdown.js", "app.js", "sw.js"]
for name in required_web:
    if not (root / "app" / name).is_file():
        bad.append(f"missing web module: app/{name}")
if '<script type="module" src="/app.js"></script>' not in index:
    bad.append("index.html must load /app.js as an external ES module")
inline = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", index, re.S | re.I)
if any(chunk.strip() for chunk in inline):
    bad.append("index.html must not contain inline application JavaScript")
if len(index.encode()) > 20_000:
    bad.append("index.html grew beyond 20 KB; keep application code in modules")
app_js = (root / "app/app.js").read_text(encoding="utf-8")
api_js = (root / "app/api.js").read_text(encoding="utf-8")
markdown_js = (root / "app/markdown.js").read_text(encoding="utf-8")
feature_markers = {
    "markdown/code UI": "renderMarkdown",
    "parallel running sessions": "running: new Map()",
    "steer/queue": "deliveryMode: 'steer'",
    "session management": "forkWithFallback",
    "project handoff": "continueInProject",
    "deep links": "setSessionHash",
    "git UI": "openGitDialog",
    "usage/context": "usageSummary",
    "notifications": "notifyUser",
    "tool renderers": "renderTool",
    "draft autosave": "scheduleDraftSave",
}
for feature, marker in feature_markers.items():
    if marker not in app_js:
        bad.append(f"web feature marker missing: {feature}")
if "highlightCode" not in markdown_js or "copy-code" not in markdown_js:
    bad.append("markdown module must keep fenced-code highlighting/copy UI")
for endpoint in ("/session/active", "/session/${encodeURIComponent(sessionID)}/fork", "/session/${encodeURIComponent(sessionID)}/diff", "/vcs/status", "/vcs"):
    if endpoint not in api_js:
        bad.append(f"web API capability missing: {endpoint}")

ipv4 = re.compile(r"(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)")
secrets = [
    re.compile(r"\bgh[opsu]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bsk-(?:sp-|ws-)?[A-Za-z0-9][A-Za-z0-9_-]{15,}\b"),
]
personal_paths = [
    re.compile(r"/(?:home|Users)/[^/\s'\"<>]+/"),
    re.compile(r"[A-Za-z]:\\Users\\[^\\\s'\"<>]+\\", re.I),
]
for path in root.rglob("*"):
    if not path.is_file() or ".git" in path.parts or "__pycache__" in path.parts or path.name == ".env":
        continue
    text = path.read_text(encoding="utf-8", errors="ignore")
    rel = path.relative_to(root)
    if ipv4.search(text): bad.append(f"network address: {rel}")
    if any(pattern.search(text) for pattern in secrets): bad.append(f"secret: {rel}")
    if any(pattern.search(text) for pattern in personal_paths): bad.append(f"personal absolute path: {rel}")

config = json.loads((root / "config/opencode.json.template").read_text(encoding="utf-8"))
for legacy in ("provider", "agent", "permission"):
    if legacy in config: bad.append(f"legacy V1 top-level field in OpenCode config: {legacy}")
if "instructions" in config:
    bad.append("V2 instructions config is currently retained but not loaded; use installed AGENTS.md instead")
providers = config.get("providers")
if not isinstance(providers, dict):
    bad.append("OpenCode config must contain native V2 providers map")
    providers = {}
provider = providers.get("bailian-cli", {})
expected = {
    "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash",
    "glm-5.2", "deepseek-v4-pro", "deepseek-v4-pro-0813", "deepseek-v4-flash-0731",
}
compat_ids = {"qwen3.8-max-preview"}
models_map = provider.get("models", {}) if isinstance(provider, dict) else {}
models = set(models_map)
missing = sorted(expected - models)
if missing: bad.append("Alibaba Token Plan Personal models missing: " + ", ".join(missing))
unexpected = sorted(models - expected - compat_ids)
if unexpected: bad.append("Alibaba models not in current Personal allowlist: " + ", ".join(unexpected))
if provider.get("name") != "Alibaba Cloud Model Studio · Token Plan Personal Pro": bad.append("Alibaba provider must identify Token Plan Personal Pro")
if provider.get("package") != "aisdk:@ai-sdk/anthropic": bad.append("Alibaba V2 provider must use aisdk:@ai-sdk/anthropic")
settings = provider.get("settings", {})
if settings.get("baseURL") != "{env:TOKEN_PLAN_ANTHROPIC_BASE_URL}": bad.append("Alibaba provider baseURL must come from TOKEN_PLAN_ANTHROPIC_BASE_URL")
if settings.get("apiKey") != "{env:TOKEN_PLAN_API_KEY}": bad.append("Alibaba provider apiKey must come from TOKEN_PLAN_API_KEY")
for legacy in ("npm", "options"):
    if legacy in provider: bad.append(f"legacy V1 Alibaba provider field: {legacy}")
for model_id, model in models_map.items():
    for legacy in ("modalities", "options", "reasoning", "tool_call"):
        if legacy in model: bad.append(f"legacy/ignored V1 model field: {model_id}.{legacy}")
    caps = model.get("capabilities", {})
    if caps.get("tools") is not True: bad.append(f"Alibaba model missing explicit tool capability: {model_id}")
    if caps.get("output") != ["text"]: bad.append(f"Alibaba model output capability must be text: {model_id}")
    if not caps.get("input") or "text" not in caps["input"]: bad.append(f"Alibaba model missing text input capability: {model_id}")
compat = models_map.get("qwen3.8-max-preview", {})
if compat.get("modelID") != "qwen3.8-max": bad.append("legacy qwen3.8-max-preview session alias must map to qwen3.8-max")
ollama = providers.get("ollama", {})
if ollama.get("package") != "aisdk:@ai-sdk/openai-compatible": bad.append("local Ollama V2 provider must use aisdk:@ai-sdk/openai-compatible")
agents = config.get("agents")
if not isinstance(agents, dict):
    bad.append("OpenCode config must contain native V2 agents map")
    agents = {}
legacy_agent_fields = {"prompt", "permission", "temperature", "top_p", "options", "maxSteps", "tools", "disable"}
for agent_id, agent in agents.items():
    found = sorted(legacy_agent_fields.intersection(agent))
    if found: bad.append(f"legacy V1 agent fields in {agent_id}: {', '.join(found)}")
    rules = agent.get("permissions", [])
    if rules and not isinstance(rules, list): bad.append(f"agent permissions must be ordered V2 array: {agent_id}")
if config.get("default_agent") != "build": bad.append("default_agent must remain build")
if bad: raise SystemExit("\n".join(bad))
print(f"Verification passed; modular web client; native V2 config; Alibaba Personal models: {len(expected)} current + {len(compat_ids)} compatibility ID")
PY
