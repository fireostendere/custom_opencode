#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
COPY="$TMP/custom-opencode"
HOME_DIR="$TMP/home"
FAKE_BIN="$TMP/bin"
LOG="$TMP/commands.log"

mkdir -p "$COPY" "$HOME_DIR" "$FAKE_BIN"
cp -a "$ROOT/." "$COPY/"
rm -f "$COPY/.env"

cat >"$COPY/.env" <<EOF
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=test
OPENCODE_WEB_HOST=localhost
OPENCODE_WEB_PORT=4098
OPENCODE_SCRATCH_DIRECTORY=$HOME_DIR/scratch
MCP_RAG_ENABLED=0
INSTALL_OPENCODE_CONFIG=0
CUSTOM_OPENCODE_INSTALL_SELFTEST=0
PONYTAIL_ENABLED=0
PONYTAIL_DEFAULT_MODE=full
EOF
chmod 0600 "$COPY/.env"

cat >"$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"${CUSTOM_OPENCODE_V2_BOOTSTRAP_LOG:?}"
exit 0
EOF
chmod +x "$FAKE_BIN/systemctl"

cat >"$FAKE_BIN/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\n' "$*" >>"${CUSTOM_OPENCODE_V2_BOOTSTRAP_LOG:?}"
if [[ "$*" != "install --global --prefix $HOME/.local @opencode-ai/cli@beta" ]]; then
  echo "unexpected npm invocation: $*" >&2
  exit 2
fi
mkdir -p "$HOME/.local/bin"
cat >"$HOME/.local/bin/opencode2" <<'INNER'
#!/usr/bin/env bash
printf 'opencode2 %s\n' "$*" >>"${CUSTOM_OPENCODE_V2_BOOTSTRAP_LOG:?}"
exit 0
INNER
chmod +x "$HOME/.local/bin/opencode2"
EOF
chmod +x "$FAKE_BIN/npm"

# An unversioned legacy-shaped binary is intentionally present. The installer/wrapper must never
# probe or execute it: custom_opencode has exactly one OpenCode runtime, opencode2.
cat >"$FAKE_BIN/opencode" <<'EOF'
#!/usr/bin/env bash
printf 'FORBIDDEN-opencode %s\n' "$*" >>"${CUSTOM_OPENCODE_V2_BOOTSTRAP_LOG:?}"
exit 99
EOF
chmod +x "$FAKE_BIN/opencode"

CUSTOM_OPENCODE_V2_BOOTSTRAP_LOG="$LOG" HOME="$HOME_DIR" PATH="$FAKE_BIN:/usr/bin:/bin" \
  bash "$COPY/scripts/install.sh" >"$TMP/install.out"

grep -Fxq "npm install --global --prefix $HOME_DIR/.local @opencode-ai/cli@beta" "$LOG"
[[ -x "$HOME_DIR/.local/bin/opencode2" ]] || {
  echo "clean install did not bootstrap opencode2" >&2
  exit 1
}

WRAPPER="$HOME_DIR/.local/bin/custom-opencode"
[[ -x "$WRAPPER" ]] || { echo "custom-opencode wrapper missing" >&2; exit 1; }
CUSTOM_OPENCODE_V2_BOOTSTRAP_LOG="$LOG" HOME="$HOME_DIR" PATH="$FAKE_BIN:/usr/bin:/bin" \
  "$WRAPPER" --version

grep -Fxq 'opencode2 --version' "$LOG"
if grep -Fq 'FORBIDDEN-opencode' "$LOG"; then
  echo "unversioned compatibility path was executed" >&2
  exit 1
fi
if grep -Fq 'exec opencode ' "$WRAPPER"; then
  echo "unversioned fallback remains in generated wrapper" >&2
  exit 1
fi

echo "OpenCode V2 bootstrap regression passed: clean install provisions and runs opencode2 only"