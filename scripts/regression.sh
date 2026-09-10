#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

STRICT=${CUSTOM_OPENCODE_REGRESSION_STRICT:-0}
REQUIRE_BROWSER=${CUSTOM_OPENCODE_REGRESSION_REQUIRE_BROWSER:-$STRICT}
REQUIRE_PACKAGED_TUI=${CUSTOM_OPENCODE_REGRESSION_REQUIRE_PACKAGED_TUI:-$STRICT}
REQUIRE_LIVE_RAG=${CUSTOM_OPENCODE_REGRESSION_REQUIRE_LIVE_RAG:-$STRICT}
SKIPS=0

step() { printf '\n==> %s\n' "$1"; }
skip() { SKIPS=$((SKIPS + 1)); printf 'SKIP %s\n' "$1"; }

step "Static/runtime verifier"
bash scripts/verify.sh

step "Ponytail managed checkout regression"
bash scripts/ponytail-provision-regression.sh

step "Runtime V3 verifier"
bash scripts/verify-runtime-v3.sh

step "Model routing / effort regression"
python3 scripts/model-routing-effort-smoke.py

step "Fresh install/update regression"
bash scripts/install-regression.sh

step "Bootstrap regression"
bash scripts/bootstrap-regression.sh

step "Composed web server regression"
python3 scripts/web-server-smoke.py

step "Web auth security regression"
python3 scripts/web-security-smoke.py

step "Multi-user accounts regression"
python3 scripts/web-users-smoke.py

step "Runtime invariant regression"
python3 scripts/runtime-invariants-smoke.py

step "MCP automatic reconnect regression"
node scripts/mcp-reconnect-regression.mjs

step "Tool Fabric configuration regression"
node scripts/tool-fabric-config-smoke.mjs
FABRIC_TEST_PYTHON=${OPENCODE_FABRIC_PYTHON:-python3}
if "$FABRIC_TEST_PYTHON" -c 'from mcp.server import MCPServer; from packaging.licenses import canonicalize_license_expression; import jsonschema' >/dev/null 2>&1; then
  step "Tool Fabric broker / MCP wire regression"
  "$FABRIC_TEST_PYTHON" scripts/tool-fabric-smoke.py
elif [[ ${OPENCODE_TOOL_FABRIC:-0} == 1 ]]; then
  echo "Enabled Tool Fabric is missing its dependencies" >&2
  exit 1
else
  skip "Tool Fabric broker: optional SDK environment not installed"
fi

step "TUI server wizard regression"
node scripts/tui-server-wizard-regression.mjs

step "TUI limits regression"
node scripts/tui-regression.mjs

step "TUI WSL clipboard regression"
node scripts/tui-clipboard-regression.mjs

step "TUI model selector regression"
node scripts/model-selector-smoke.mjs

step "TUI JSX pragma regression"
node scripts/tui-jsx-pragma-regression.mjs

step "Browser regressions"
if python3 - <<'PY'
try:
    import playwright.sync_api  # noqa: F401
except Exception:
    raise SystemExit(1)
PY
then
  if python3 - <<'PY'
from playwright.sync_api import sync_playwright
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
        browser.close()
except Exception:
    raise SystemExit(1)
PY
  then
    python3 scripts/queue-badge-convergence.py
    python3 scripts/web-critical-controls-e2e.py
    python3 scripts/web-panel-scroll-e2e.py
    python3 scripts/web-runtime-status-e2e.py
    python3 scripts/web-fixture-e2e.py
  elif [[ "$REQUIRE_BROWSER" == 1 ]]; then
    echo "Playwright is installed but Chromium is unavailable" >&2
    exit 1
  else
    skip "browser regressions: Chromium unavailable"
  fi
elif [[ "$REQUIRE_BROWSER" == 1 ]]; then
  echo "Playwright is unavailable" >&2
  exit 1
else
  skip "browser regressions: Playwright unavailable"
fi

step "Packaged OpenCode 2 TUI regression"
if command -v opencode2 >/dev/null 2>&1; then
  bash scripts/tui-package-smoke.sh
elif [[ "$REQUIRE_PACKAGED_TUI" == 1 ]]; then
  echo "opencode2 is unavailable" >&2
  exit 1
else
  skip "packaged TUI: opencode2 unavailable"
fi

step "RAG regression"
RAG_AVAILABLE=0
if OPENCODE_SERVER_PASSWORD=${OPENCODE_SERVER_PASSWORD:-test} \
   OPENCODE_BACKEND_URL=${OPENCODE_BACKEND_URL:-http://127.0.0.1:9} \
   OPENCODE_BACKEND_PASSWORD=${OPENCODE_BACKEND_PASSWORD:-test} \
   python3 - <<'PY'
import sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd() / 'app'))
try:
    import server_plus
except BaseException:
    raise SystemExit(1)
raise SystemExit(0 if server_plus._rag_runtime().get('available') else 1)
PY
then
  RAG_AVAILABLE=1
fi

if [[ "$RAG_AVAILABLE" == 1 ]]; then
  python3 scripts/rag-live-regression.py
elif [[ "$REQUIRE_LIVE_RAG" == 1 ]]; then
  echo "Live mcp-rag runtime/corpus is unavailable" >&2
  exit 1
else
  python3 scripts/rag-start-smoke.py
  skip "live RAG retrieval: local mcp-rag runtime/corpus unavailable"
fi

if [[ "$SKIPS" -eq 0 ]]; then
  printf '\nFULL REGRESSION PASS\n'
else
  printf '\nAVAILABLE REGRESSION PASS (%d optional gate(s) skipped)\n' "$SKIPS"
  printf 'Set CUSTOM_OPENCODE_REGRESSION_STRICT=1 to require browser + packaged TUI + live RAG.\n'
fi
