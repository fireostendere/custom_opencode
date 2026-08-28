#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PYTHON3=$(command -v python3 || true)
NODE=$(command -v node || true)
if [[ -z "$PYTHON3" ]]; then echo "python3 is required" >&2; exit 1; fi
if [[ -z "$NODE" ]]; then echo "node is required" >&2; exit 1; fi

INLINE_JS="${TMPDIR:-/tmp}/custom-opencode-inline.js"
"$PYTHON3" -m py_compile "$ROOT/app/server.py"
"$PYTHON3" - "$ROOT/app/index.html" "$INLINE_JS" <<'PY'
from pathlib import Path
import re, sys
html = Path(sys.argv[1]).read_text(encoding="utf-8")
scripts = re.findall(r"<script>(.*?)</script>", html, re.S)
Path(sys.argv[2]).write_text("\n".join(scripts), encoding="utf-8")
if not scripts:
    raise SystemExit("No inline JavaScript found")
PY
"$NODE" --check "$INLINE_JS"

for file in "$ROOT/config/events.js" "$ROOT/config/plugins/"*.js; do
  "$NODE" --check "$file"
done
for file in "$ROOT/scripts/"*.sh; do
  bash -n "$file"
done

"$PYTHON3" - "$ROOT" <<'PY'
from pathlib import Path
import json, re, sys

root = Path(sys.argv[1])
ipv4 = re.compile(r"(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)")
secrets = [
    re.compile(r"\bgh[opsu]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bsk-(?:sp-|ws-)?[A-Za-z0-9][A-Za-z0-9_-]{15,}\b"),
]
personal_paths = [
    re.compile(r"/(?:home|Users)/[^/\s'\"<>]+/"),
    re.compile(r"[A-Za-z]:\\Users\\[^\\\s'\"<>]+\\", re.I),
]
bad = []
for path in root.rglob("*"):
    if not path.is_file() or ".git" in path.parts or "__pycache__" in path.parts or path.name == ".env":
        continue
    text = path.read_text(encoding="utf-8", errors="ignore")
    rel = path.relative_to(root)
    if ipv4.search(text):
        bad.append(f"network address: {rel}")
    if any(pattern.search(text) for pattern in secrets):
        bad.append(f"secret: {rel}")
    if any(pattern.search(text) for pattern in personal_paths):
        bad.append(f"personal absolute path: {rel}")

config_path = root / "config/opencode.json.template"
config = json.loads(config_path.read_text(encoding="utf-8"))
provider = config["provider"]["bailian-cli"]
expected = {
    "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash",
    "deepseek-v4-pro", "deepseek-v4-pro-0813", "deepseek-v4-flash", "deepseek-v4-flash-0731", "deepseek-v3.2",
    "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5",
    "glm-5.2", "glm-5.1", "glm-5", "MiniMax-M2.5",
}
models = set(provider.get("models", {}))
missing = sorted(expected - models)
if missing:
    bad.append("Alibaba Token Plan models missing: " + ", ".join(missing))
if provider.get("npm") != "@ai-sdk/anthropic":
    bad.append("Alibaba provider must use @ai-sdk/anthropic")
if provider.get("options", {}).get("baseURL") != "{env:TOKEN_PLAN_ANTHROPIC_BASE_URL}":
    bad.append("Alibaba provider baseURL must come from TOKEN_PLAN_ANTHROPIC_BASE_URL")
if provider.get("options", {}).get("apiKey") != "{env:TOKEN_PLAN_API_KEY}":
    bad.append("Alibaba provider apiKey must come from TOKEN_PLAN_API_KEY")

if bad:
    raise SystemExit("\n".join(bad))
print(f"Verification passed; Alibaba models: {len(expected)} required, {len(models)} configured")
PY
