#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PYTHON3=$(command -v python3)
TMP_ROOT=$(mktemp -d)
WEB_PID=""
BACKEND_PID=""
cleanup() {
  if [[ -n "$WEB_PID" ]]; then kill "$WEB_PID" 2>/dev/null || true; fi
  if [[ -n "$BACKEND_PID" ]]; then kill "$BACKEND_PID" 2>/dev/null || true; fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

HOME="$TMP_ROOT/home"
export HOME
mkdir -p "$HOME"
REMOTE="$TMP_ROOT/origin.git"
WORK="$TMP_ROOT/work"
PUBLISHER="$TMP_ROOT/publisher"
SHIM="$TMP_ROOT/bin"
mkdir -p "$SHIM"

# Simulate the user-level service manager and OpenCode V2 CLI. The regression
# starts the real custom_opencode web server separately below, so the systemd
# shim only removes CI-runner coupling from install/update mechanics.
cat >"$SHIM/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$SHIM/opencode2" <<'EOF'
#!/usr/bin/env bash
if [[ " ${*:-} " == *" --version "* ]]; then
  echo "opencode2 regression stub"
fi
exit 0
EOF
chmod 0755 "$SHIM/systemctl" "$SHIM/opencode2"
export PATH="$SHIM:$PATH"

# Make an isolated remote whose main points at the exact candidate commit. This
# lets the installed updater exercise fetch + fast-forward without touching the
# source checkout used by CI or development.
git clone --bare "$SOURCE_ROOT" "$REMOTE" >/dev/null 2>&1
CANDIDATE=$(git -C "$SOURCE_ROOT" rev-parse HEAD)
git --git-dir="$REMOTE" update-ref refs/heads/main "$CANDIDATE"
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/main
git clone "$REMOTE" "$WORK" >/dev/null 2>&1

free_port() {
  "$PYTHON3" - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("localhost", 0))
    print(sock.getsockname()[1])
PY
}
BACKEND_PORT=$(free_port)
WEB_PORT=$(free_port)

cat >"$WORK/.env" <<EOF
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=test
OPENCODE_WEB_HOST=localhost
OPENCODE_WEB_PORT=$WEB_PORT
OPENCODE_WEB_ALLOW_LOCAL=1
OPENCODE_SCRATCH_DIRECTORY=$HOME/scratch
OPENCODE_PROJECT_ROOTS=$WORK
OPENCODE_BACKEND_URL=http://localhost:$BACKEND_PORT
OPENCODE_BACKEND_USERNAME=opencode
OPENCODE_BACKEND_PASSWORD=test
OPENCODE_PERMISSION_POLICY=workspace
OPENCODE_PERMISSION_AUDIT=1
CUSTOM_OPENCODE_STATE_DIR=$HOME/.local/state/custom-opencode
TOKEN_PLAN_API_KEY=test
TOKEN_PLAN_ANTHROPIC_BASE_URL=https://token-plan.example.invalid/apps/anthropic/v1
TOKEN_PLAN_OPENAI_BASE_URL=https://token-plan.example.invalid/compatible-mode/v1
TOKEN_PLAN_PROBE_MODEL=qwen3.8-max
QWEN_QUOTA_PROBE_ENABLED=0
MCP_RAG_ENABLED=0
OLLAMA_BASE_URL=http://localhost:11434/v1
OPENCODE_LOCAL_AUTO_START=0
OPENCODE_LOCAL_PROVIDER=ollama
INSTALL_OPENCODE_CONFIG=1
CUSTOM_OPENCODE_INSTALL_SELFTEST=0
EOF
chmod 0600 "$WORK/.env"

# Static and zero-token regression from the clean clone.
"$WORK/scripts/verify.sh"
"$PYTHON3" "$WORK/scripts/control-plane-smoke.py"

# Fresh install into an empty HOME.
"$WORK/scripts/install.sh"
test -x "$HOME/.local/bin/custom-opencode"
test -L "$HOME/.local/bin/custom-opencode-update"
test -f "$HOME/.config/opencode/opencode.json"
test -f "$HOME/.config/systemd/user/opencode-web-client.service"
"$HOME/.local/bin/custom-opencode" --version | grep -q "opencode2 regression stub"

# Advance the isolated remote and make the installed updater perform a real
# fetch + fast-forward + reinstall cycle.
git clone "$REMOTE" "$PUBLISHER" >/dev/null 2>&1
git -C "$PUBLISHER" config user.name "Regression"
git -C "$PUBLISHER" config user.email "regression@example.invalid"
echo "update path exercised" >"$PUBLISHER/.clean-install-update-marker"
git -C "$PUBLISHER" add .clean-install-update-marker
git -C "$PUBLISHER" commit -m "test: advance isolated regression remote" >/dev/null
git -C "$PUBLISHER" push origin main >/dev/null 2>&1
"$HOME/.local/bin/custom-opencode-update"
test -f "$WORK/.clean-install-update-marker"

# Minimal fake OpenCode backend for a real proxy/control-plane/web launch.
cat >"$TMP_ROOT/fake_backend.py" <<'PY'
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from urllib.parse import urlsplit

WORKSPACE = os.environ["REGRESSION_WORKSPACE"]
PORT = int(os.environ["REGRESSION_BACKEND_PORT"])
pending = True

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, fmt, *args):
        pass
    def send_json(self, value, status=200):
        raw = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def do_GET(self):
        global pending
        path = urlsplit(self.path).path
        if path == "/api/session/regression-session":
            self.send_json({"id": "regression-session", "location": {"directory": WORKSPACE}})
            return
        if path == "/api/permission/request":
            value = [{
                "id": "permission-read",
                "sessionID": "regression-session",
                "action": "shell",
                "resources": ["cat README.md"],
            }] if pending else []
            self.send_json(value)
            return
        if path == "/regression-state":
            self.send_json({"pending": pending})
            return
        self.send_json([], 200)
    def do_POST(self):
        global pending
        path = urlsplit(self.path).path
        length = int(self.headers.get("Content-Length", "0"))
        if length:
            self.rfile.read(length)
        if path == "/api/session/regression-session/permission/permission-read/reply":
            pending = False
            self.send_json({"ok": True})
            return
        self.send_json({"ok": True})

ThreadingHTTPServer(("localhost", PORT), Handler).serve_forever()
PY
REGRESSION_WORKSPACE="$WORK" REGRESSION_BACKEND_PORT="$BACKEND_PORT" \
  "$PYTHON3" "$TMP_ROOT/fake_backend.py" >"$TMP_ROOT/backend.log" 2>&1 &
BACKEND_PID=$!

(
  cd "$WORK/app"
  exec "$PYTHON3" server_rag.py
) >"$TMP_ROOT/web.log" 2>&1 &
WEB_PID=$!

ready=0
for _ in $(seq 1 80); do
  if curl -fsS "http://localhost:$WEB_PORT/" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.25
done
if [[ "$ready" != 1 ]]; then
  cat "$TMP_ROOT/web.log" >&2 || true
  exit 1
fi

curl -fsS "http://localhost:$WEB_PORT/" | grep -q '/control-plane.js'
curl -fsS "http://localhost:$WEB_PORT/client-control-plane.json" | "$PYTHON3" -c \
  'import json,sys; value=json.load(sys.stdin); assert value["permissionPolicy"]["preset"] == "workspace"'
curl -fsS -X POST -H 'Content-Type: application/json' \
  --data '{"sessionID":"regression-session","permissionID":"permission-read"}' \
  "http://localhost:$WEB_PORT/client-permission-evaluate.json" | "$PYTHON3" -c \
  'import json,sys; value=json.load(sys.stdin); assert value["ok"] and value["autoReplied"] and value["risk"] == "R0"'
curl -fsS "http://localhost:$BACKEND_PORT/regression-state" | "$PYTHON3" -c \
  'import json,sys; assert json.load(sys.stdin)["pending"] is False'

echo "Clean install regression passed: fresh install + CLI launch + updater fast-forward/reinstall + real web/control-plane server"
