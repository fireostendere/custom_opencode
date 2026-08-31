#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PYTHON3=$(command -v python3 || true)
NODE=$(command -v node || true)
if [[ -z "$PYTHON3" ]]; then echo "python3 is required" >&2; exit 1; fi
if [[ -z "$NODE" ]]; then echo "node is required" >&2; exit 1; fi

"$PYTHON3" -m py_compile \
  "$ROOT/app/server.py" "$ROOT/app/server_ext.py" "$ROOT/app/server_plus.py" \
  "$ROOT/app/server_rag.py" "$ROOT/app/server_features.py" "$ROOT/app/server_control.py" \
  "$ROOT/app/server_workflow.py" "$ROOT/app/server_runtime.py" "$ROOT/app/runtime_store.py" \
  "$ROOT/app/model_registry.py" "$ROOT/app/repo_services.py" "$ROOT/app/runtime_resume.py" \
  "$ROOT/scripts/rag-probe.py" "$ROOT/scripts/rag-start-smoke.py" "$ROOT/scripts/runtime-smoke.py" \
  "$ROOT/scripts/runtime-resume-smoke.py"

WORKSPACE_TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$WORKSPACE_TEST_ROOT"' EXIT
mkdir -p "$WORKSPACE_TEST_ROOT/projects/alpha/sub" "$WORKSPACE_TEST_ROOT/outside"
ln -s "$WORKSPACE_TEST_ROOT/outside" "$WORKSPACE_TEST_ROOT/projects/escape-link"
OPENCODE_SERVER_PASSWORD=test \
OPENCODE_BACKEND_URL=http://localhost:9 \
OPENCODE_BACKEND_PASSWORD=test \
OPENCODE_SCRATCH_DIRECTORY="$WORKSPACE_TEST_ROOT/scratch" \
OPENCODE_PROJECT_ROOTS="$WORKSPACE_TEST_ROOT/projects" \
"$PYTHON3" - "$ROOT/app" <<'PY'
import json
import os
import sys

sys.path.insert(0, sys.argv[1])
import server
import server_plus

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

root = server_plus.directory_snapshot()
assert len(root["roots"]) == 1
projects_root = root["roots"][0]["path"]
listing = server_plus.directory_snapshot(projects_root)
names = {item["name"] for item in listing["directories"]}
assert "alpha" in names
assert "escape-link" not in names
outside = server_plus.directory_snapshot(os.path.dirname(projects_root))
assert outside.get("error") == "directory-outside-allowed-roots"
print("Session isolation + project-browser boundary self-check passed")
PY
rm -rf "$WORKSPACE_TEST_ROOT"
trap - EXIT

for file in "$ROOT/app/"*.js "$ROOT/config/events.js" "$ROOT/config/plugins/"*.js; do
  "$NODE" --check "$file"
done
"$NODE" "$ROOT/scripts/web-smoke.mjs"
"$NODE" "$ROOT/scripts/session-transfer-smoke.mjs"
"$PYTHON3" "$ROOT/scripts/limits-smoke.py"
"$PYTHON3" "$ROOT/scripts/rag-start-smoke.py"
"$PYTHON3" "$ROOT/scripts/runtime-smoke.py"
"$PYTHON3" "$ROOT/scripts/runtime-resume-smoke.py"
for file in "$ROOT/scripts/"*.sh; do
  bash -n "$file"
done
# Ponytail provisioning script must exist and be sourceable.
if [[ ! -f "$ROOT/scripts/ponytail-provision.sh" ]]; then
  echo "ponytail provisioning script missing" >&2
  exit 1
fi
if ! source "$ROOT/scripts/ponytail-provision.sh"; then
  echo "ponytail provisioning script is not sourceable" >&2
  exit 1
fi
if ! declare -f ponytail_provision >/dev/null; then
  echo "ponytail provisioning script does not export ponytail_provision()" >&2
  exit 1
fi
if ! grep -q 'service set env' "$ROOT/scripts/install.sh"; then
  echo "installer must persist the active V2 service environment" >&2
  exit 1
fi
if ! grep -q 'env -u OPENCODE_CONFIG_DIR opencode2' "$ROOT/scripts/install.sh"; then
  echo "installer must write registration through the shared service root" >&2
  exit 1
fi
if ! grep -q 'CONFIG_DIR.*!=.*SHARED_CONFIG_DIR' "$ROOT/scripts/install.sh"; then
  echo "installer must reject a config root ignored by the shared V2 launcher" >&2
  exit 1
fi
if ! grep -q 'QWEN_QUOTA_PROBE_ENABLED || "0"' "$ROOT/config/plugins/qwen-quota.js"; then
  echo "completion-based quota probe must remain explicit opt-in" >&2
  exit 1
fi

"$PYTHON3" - "$ROOT" <<'PY'
from pathlib import Path
import ipaddress
import json
import re
import sys

root = Path(sys.argv[1])
bad: list[str] = []

index = (root / "app/index.html").read_text(encoding="utf-8")
required_web = [
    "styles.css", "api.js", "markdown.js", "app.js", "enhancements.css",
    "enhancements.js", "ui-enhancements.css", "ui-enhancements.js", "rag-control.js",
    "design-system.css", "sidebar-resize.js",
    "sw.js", "server.py", "server_ext.py",
    "server_plus.py", "server_rag.py", "server_features.py", "server_control.py",
    "server_workflow.py", "server_runtime.py", "runtime_store.py", "model_registry.py",
    "repo_services.py", "runtime_resume.py", "runtime-dashboard.js", "runtime-dashboard.css",
]
for name in required_web:
    if not (root / "app" / name).is_file():
        bad.append(f"missing web module: app/{name}")
for script in (
    '<script type="module" src="/app.js"></script>',
    '<script type="module" src="/rag-control.js"></script>',
    '<script type="module" src="/enhancements.js"></script>',
    '<script type="module" src="/ui-enhancements.js"></script>',
    '<script type="module" src="/runtime-dashboard.js"></script>',
    '<script type="module" src="/sidebar-resize.js"></script>',
):
    if script not in index:
        bad.append(f"index.html missing module: {script}")
if index.find('/rag-control.js') > index.find('/enhancements.js'):
    bad.append("rag-control.js must load before enhancements.js so /rag-start intercepts native slash submission")
for css in ("/enhancements.css", "/ui-enhancements.css", "/runtime-dashboard.css", "/design-system.css"):
    if f'href="{css}"' not in index:
        bad.append(f"index.html missing stylesheet: {css}")
if 'id="providerLimits"' not in index or 'id="slashPalette"' not in index:
    bad.append("index.html must expose provider limits and slash palette surfaces")
if '<input type="hidden" id="modelSearch"' not in index:
    bad.append("model picker search must stay hidden to avoid mobile keyboard pop-up")
inline = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", index, re.S | re.I)
if any(chunk.strip() for chunk in inline):
    bad.append("index.html must not contain inline application JavaScript")
if len(index.encode()) > 24_000:
    bad.append("index.html grew beyond 24 KB; keep application code in modules")

app_js = (root / "app/app.js").read_text(encoding="utf-8")
api_js = (root / "app/api.js").read_text(encoding="utf-8")
markdown_js = (root / "app/markdown.js").read_text(encoding="utf-8")
enhancements_js = (root / "app/enhancements.js").read_text(encoding="utf-8")
ui_js = (root / "app/ui-enhancements.js").read_text(encoding="utf-8")
rag_control_js = (root / "app/rag-control.js").read_text(encoding="utf-8")
runtime_dashboard_js = (root / "app/runtime-dashboard.js").read_text(encoding="utf-8")
runtime_dashboard_css = (root / "app/runtime-dashboard.css").read_text(encoding="utf-8")
server_ext_py = (root / "app/server_ext.py").read_text(encoding="utf-8")
server_plus_py = (root / "app/server_plus.py").read_text(encoding="utf-8")
server_rag_py = (root / "app/server_rag.py").read_text(encoding="utf-8")
server_runtime_py = (root / "app/server_runtime.py").read_text(encoding="utf-8")
server_workflow_py = (root / "app/server_workflow.py").read_text(encoding="utf-8")
runtime_store_py = (root / "app/runtime_store.py").read_text(encoding="utf-8")
model_registry_py = (root / "app/model_registry.py").read_text(encoding="utf-8")
repo_services_py = (root / "app/repo_services.py").read_text(encoding="utf-8")
runtime_resume_py = (root / "app/runtime_resume.py").read_text(encoding="utf-8")
local_router_js = (root / "config/plugins/lazy-local-router.js").read_text(encoding="utf-8")
orchestrated_plugin_js = (root / "config/plugins/orchestrated-qwen.js").read_text(encoding="utf-8")
service = (root / "systemd/opencode-web-client.service").read_text(encoding="utf-8")
orchestrator = (root / "config/prompts/orchestrator.md").read_text(encoding="utf-8")
agents_policy = (root / "config/AGENTS.md").read_text(encoding="utf-8")

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
for marker in ("/api/command", "/command`", "parseSlash", "slashPalette"):
    if marker not in enhancements_js:
        bad.append(f"slash-command capability missing: {marker}")
for marker in ("parseRagStart", "/client-rag-start.json", "/rag-start", "sessionID"):
    if marker not in rag_control_js:
        bad.append(f"RAG slash-control capability missing: {marker}")
for marker in ("account/rateLimits/read", "QWEN_FIVE_HOUR_LIMIT = 12_000", "QWEN_SEVEN_DAY_LIMIT = 40_000", "/client-limits.json"):
    if marker not in server_ext_py:
        bad.append(f"provider-limit capability missing: {marker}")
for marker in ("isFreeModel", "Бесплатные модели", "/client-directories.json", "openDirectoryAsProject"):
    if marker not in ui_js:
        bad.append(f"web model/project enhancement missing: {marker}")
for marker in ("OPENCODE_PROJECT_ROOTS", "directory-outside-allowed-roots"):
    if marker not in server_plus_py:
        bad.append(f"project browser boundary missing: {marker}")
for marker in ("knowledge_base.runtime", "/api/mcp", "disabled\": False", "_persist_kb_enabled", "?{urlencode({'location[directory]': directory})}"):
    if marker not in server_rag_py:
        bad.append(f"RAG lifecycle server capability missing: {marker}")
if "app/server_rag.py" not in service or "app/server_workflow.py" not in service:
    bad.append("web systemd service must launch the composed workflow/RAG server")
if 'OPENCODE_LOCAL_PROVIDER || "ollama"' not in local_router_js or "OPENCODE_LOCAL_AUTO_START" not in local_router_js:
    bad.append("local router must stay manual/opt-in outside server runtime profiles")
for token in ("qwen3.8-max", "qwen3.8-flash#low", "qwen3.7-plus#medium", "deepseek-v4-pro-0813#high", "glm-5.2", "RAG policy"):
    if token not in orchestrator:
        bad.append(f"orchestrator must keep the provider-pinned role stack / RAG policy token: {token}")
for token in ("Planning policy", "conditional, not a ritual", "todowrite", "short, obvious, bounded", "two or more meaningful stages", "before the first file mutation"):
    if token not in orchestrator:
        bad.append(f"orchestrator must keep conditional todo planning: {token}")
for token in ("Планирование задач", "todowrite", "2-7", "до первого изменения файла", "не создавай искусственный план"):
    if token not in agents_policy:
        bad.append(f"global agent policy must keep conditional todo planning: {token}")
for marker in ('Plugin.define({', 'id: "orchestrated-qwen"', 'qwen3.8-orchestrated', 'ctx.session.hook("context"', 'Custom orchestrated Qwen policy'):
    if marker not in orchestrated_plugin_js:
        bad.append(f"orchestrated Qwen plugin marker missing: {marker}")
if not (root / "scripts/rag-mcp.sh").is_file():
    bad.append("missing portable RAG MCP launcher")
if not (root / "scripts/runtime-smoke.py").is_file():
    bad.append("missing runtime-v2 smoke test")
if not (root / "scripts/runtime-resume-smoke.py").is_file():
    bad.append("missing runtime resume smoke test")
if not (root / "docs/server-runtime-v2.md").is_file():
    bad.append("missing server runtime v2 documentation")

for marker in ("/client-tasks.json", "/client-task-control.json", "/client-model-capabilities.json", "/client-resource-status.json", "Task Center", "qwen3.8-coder"):
    if marker not in runtime_dashboard_js:
        bad.append(f"runtime dashboard marker missing: {marker}")
for marker in ("runtime-task", "runtime-profile", "runtime-state"):
    if marker not in runtime_dashboard_css:
        bad.append(f"runtime dashboard CSS marker missing: {marker}")
for marker in ("CREATE TABLE IF NOT EXISTS tasks", "CREATE TABLE IF NOT EXISTS checkpoints", "CREATE TABLE IF NOT EXISTS events", "CREATE TABLE IF NOT EXISTS usage", "CREATE TABLE IF NOT EXISTS mailbox"):
    if marker not in runtime_store_py:
        bad.append(f"runtime durable-store marker missing: {marker}")
for marker in ("qwen3.8-orchestrated", "ResourceScheduler", "ROLE_DEFAULTS", "role_models", "validate_provider_ref", "qwen3.7-plus", "deepseek-v4-pro-0813", "glm-5.2"):
    if marker not in model_registry_py:
        bad.append(f"model registry/scheduler marker missing: {marker}")
for retired in ("qwen3.8-coder", "qwen3.8-review", "game process detected"):
    if retired in model_registry_py:
        bad.append(f"retired local-router marker must stay removed from model registry: {retired}")
for marker in ("class RepoIndexer", "class ContextService", "class ArtifactStore", "class VerificationPipeline", "class SecretBroker", "semantic_diff"):
    if marker not in repo_services_py:
        bad.append(f"repo/context service marker missing: {marker}")
for marker in ("recover_inflight", "spawn_speculative", "mcp_gateway", "_create_worktree", "agent.loop_detected", "agent.stuck", "review.decision", "verification.code_failure"):
    if marker not in server_runtime_py:
        bad.append(f"server runtime integration marker missing: {marker}")
for marker in ("runtime_resume.continuation_payload", "task.resume_continuation", "effective_files"):
    if marker not in server_workflow_py:
        bad.append(f"checkpoint resume wiring marker missing: {marker}")
for marker in ("Continue the existing task", "dispatchCount", "attachmentsReplayed"):
    if marker not in runtime_resume_py:
        bad.append(f"checkpoint resume policy marker missing: {marker}")

ipv4 = re.compile(r"(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)")
documentation_networks = tuple(ipaddress.ip_network(value) for value in (
    "192.0.2.0/24",
    "198.51.100.0/24",
    "203.0.113.0/24",
))

def allowed_ipv4_literal(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return True
    if not isinstance(address, ipaddress.IPv4Address):
        return True
    return address.is_loopback or address.is_unspecified or any(address in network for network in documentation_networks)

# Keep the exception set narrow. Private/LAN, link-local metadata and public
# addresses are still treated as accidental hardcode and must fail verification.
for accepted in ("127.0.0.1", "127.42.0.9", "0.0.0.0", "192.0.2.10", "198.51.100.20", "203.0.113.30"):
    assert allowed_ipv4_literal(accepted), accepted
for octets in ((10, 0, 0, 8), (192, 168, 1, 5), (169, 254, 169, 254), (8, 8, 8, 8)):
    rejected = ".".join(str(part) for part in octets)
    assert not allowed_ipv4_literal(rejected), rejected

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
    for match in ipv4.finditer(text):
        literal = match.group(0)
        if allowed_ipv4_literal(literal):
            continue
        try:
            address = ipaddress.ip_address(literal)
        except ValueError:
            continue
        bad.append(f"network address: {rel}: {address}")
        break
    if any(pattern.search(text) for pattern in secrets): bad.append(f"secret: {rel}")
    if any(pattern.search(text) for pattern in personal_paths): bad.append(f"personal absolute path: {rel}")

config_text = (root / "config/opencode.json.template").read_text(encoding="utf-8")
config_text = config_text.replace("__CONFIG_DIR__", "/tmp/opencode-config")
config_text = config_text.replace("__CUSTOM_OPENCODE_ROOT__", "/tmp/custom-opencode")
config_text = config_text.replace("__RAG_DISABLED__", "true")
# Ponytail plugin placeholder: verifier substitutes a stub path.
ponytail_plugin = "/tmp/opencode/ponytail/.opencode/plugins/ponytail.mjs"
config_text = config_text.replace(
    "__PONYTAIL_PLUGIN_PATH__",
    json.dumps(ponytail_plugin, ensure_ascii=False)[1:-1],
)
config = json.loads(config_text)
if config.get("plugins") != [ponytail_plugin]:
    bad.append("OpenCode V2 config must expose the managed Ponytail entry point via plugins")
if "plugin" in config:
    bad.append("legacy singular V1 plugin field must not be present")
for legacy in ("provider", "agent", "permission"):
    if legacy in config: bad.append(f"legacy V1 top-level field in OpenCode config: {legacy}")
if "instructions" in config:
    bad.append("V2 instructions config is currently retained but not loaded; use installed AGENTS.md instead")
if config.get("model") != "bailian-cli/qwen3.8-max":
    bad.append("primary default model must be bailian-cli/qwen3.8-max")

mcp = config.get("mcp", {})
kb = (mcp.get("servers") or {}).get("kb", {}) if isinstance(mcp, dict) else {}
if kb.get("type") != "local" or kb.get("codemode") is not False:
    bad.append("kb MCP server must be a direct local stdio server")
if kb.get("disabled") is not True:
    bad.append("rendered verifier config must allow installer to disable absent RAG")
execution_timeout = ((kb.get("timeout") or {}).get("execution"))
if not isinstance(execution_timeout, int) or execution_timeout > 60_000:
    bad.append("kb MCP execution timeout must be bounded to <= 60 seconds")

providers = config.get("providers")
if not isinstance(providers, dict):
    bad.append("OpenCode config must contain native V2 providers map")
    providers = {}
provider = providers.get("bailian-cli", {})
expected = {
    "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash",
    "glm-5.2", "deepseek-v4-pro", "deepseek-v4-pro-0813", "deepseek-v4-flash-0731",
}
special_ids = {"qwen3.8-orchestrated"}
compat_ids = {"qwen3.8-max-preview"}
models_map = provider.get("models", {}) if isinstance(provider, dict) else {}
models = set(models_map)
missing = sorted(expected - models)
if missing: bad.append("Alibaba Token Plan Personal models missing: " + ", ".join(missing))
unexpected = sorted(models - expected - special_ids - compat_ids)
if unexpected: bad.append("Alibaba models not in current Personal allowlist: " + ", ".join(unexpected))
if provider.get("name") != "Alibaba Cloud": bad.append("Alibaba provider must be named 'Alibaba Cloud'")
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
special = models_map.get("qwen3.8-orchestrated", {})
if special.get("modelID") != "qwen3.8-max": bad.append("orchestrated Qwen catalog alias must map to qwen3.8-max")
if special.get("name") != "Qwen3.8 Max · Orchestrated": bad.append("orchestrated Qwen catalog alias has unexpected label")
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
    model_ref_value = str(agent.get("model") or "")
    if model_ref_value.startswith("ollama/"):
        bad.append(f"automatic agent must not route to local Ollama: {agent_id}")
if config.get("default_agent") != "build": bad.append("default_agent must remain build")
for native_id in ("build", "plan"):
    if native_id in agents:
        bad.append(f"native OpenCode agent must not be overridden: {native_id}")
for legacy_id in ("build-direct", "plan-direct"):
    legacy_agent = agents.get(legacy_id) or {}
    if legacy_agent.get("mode") != "primary" or legacy_agent.get("hidden") is not True:
        bad.append(f"legacy direct agent must remain hidden compatibility-only: {legacy_id}")
for agent_id in ("fast-reader", "title"):
    if (agents.get(agent_id) or {}).get("model") != "bailian-cli/qwen3.8-flash#low":
        bad.append(f"{agent_id} must use cheap qwen3.8-flash#low")
if "local-reader" in agents:
    bad.append("obsolete local-reader compatibility agent must stay removed")
role_routes = {
    "role-builder": "bailian-cli/qwen3.7-plus#medium",
    "role-builder-high": "bailian-cli/qwen3.7-plus#high",
    "role-builder-max": "bailian-cli/qwen3.7-plus#max",
    "role-reviewer": "bailian-cli/deepseek-v4-pro-0813#high",
    "role-reviewer-max": "bailian-cli/deepseek-v4-pro-0813#max",
    "role-long-horizon": "bailian-cli/glm-5.2#high",
    "role-long-horizon-max": "bailian-cli/glm-5.2#max",
}
for agent_id, model_ref in role_routes.items():
    if (agents.get(agent_id) or {}).get("model") != model_ref:
        bad.append(f"role agent {agent_id} must stay provider-pinned to {model_ref}")
fast_rules = (agents.get("fast-reader") or {}).get("permissions", [])
if not any(rule.get("action") == "kb_knowledge_search" and rule.get("effect") == "allow" for rule in fast_rules):
    bad.append("fast-reader must be allowed to perform selective RAG search")
if any(rule.get("action") == "kb_knowledge_ingest" and rule.get("effect") == "allow" for rule in fast_rules):
    bad.append("fast-reader must not be allowed to ingest knowledge")

global_rules = config.get("permissions", [])
if not any(rule.get("action") == "kb_knowledge_ingest" and rule.get("effect") == "ask" for rule in global_rules):
    bad.append("knowledge ingestion must require explicit permission")

if bad:
    raise SystemExit("\n".join(bad))
print(f"Verification passed; native Build/Plan + dedicated orchestrated Qwen + runtime-v2/checkpoint resume + bounded RAG lifecycle + Alibaba Personal models: {len(expected)} current + {len(special_ids)} orchestrated alias + {len(compat_ids)} compatibility ID")
PY
