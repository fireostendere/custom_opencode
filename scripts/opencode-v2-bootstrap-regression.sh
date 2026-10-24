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
if [[ "$*" == "uninstall --global --prefix $HOME/.local @opencode-ai/cli" ]]; then
  rm -rf "$HOME/.local/lib/node_modules/@opencode-ai/cli"
  rm -f "$HOME/.local/bin/opencode2"
  exit 0
fi
if [[ "$*" != "install --global --prefix $HOME/.local @opencode/cli@2.1.4" && "$*" != "install --global --prefix $HOME/.local/share/custom-opencode/cli @opencode/cli@2.1.4" ]]; then
  echo "unexpected npm invocation: $*" >&2
  exit 2
fi
[[ ! -e "$HOME/.local/lib/node_modules/@opencode-ai/cli/package.json" ]] || {
  echo 'legacy npm package still owns opencode2' >&2; exit 1;
}
PREFIX=$4
mkdir -p "$PREFIX/bin"
if [[ -f "$PREFIX/bin/opencode" && ! -L "$PREFIX/bin/opencode" ]]; then
  echo 'EEXIST: user opencode wrapper' >&2; exit 1
fi
mkdir -p "$PREFIX/lib/node_modules/@opencode/cli/bin"
: >"$PREFIX/lib/node_modules/@opencode/cli/postinstall.mjs"
cat >"$PREFIX/lib/node_modules/@opencode/cli/bin/opencode.exe" <<'INNER'
#!/usr/bin/env bash
echo 'postinstall script was not run' >&2
exit 1
INNER
chmod +x "$PREFIX/lib/node_modules/@opencode/cli/bin/opencode.exe"
ln -sfn ../lib/node_modules/@opencode/cli/bin/opencode.exe "$PREFIX/bin/opencode2"
EOF
chmod +x "$FAKE_BIN/npm"

cat >"$FAKE_BIN/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "$HOME/.local/lib/node_modules/@opencode/cli/postinstall.mjs" || "$1" == "$HOME/.local/share/custom-opencode/cli/lib/node_modules/@opencode/cli/postinstall.mjs" ]] || exit 2
printf 'node %s\n' "$*" >>"${CUSTOM_OPENCODE_V2_BOOTSTRAP_LOG:?}"
PACKAGE=${1%/postinstall.mjs}
cat >"$PACKAGE/bin/opencode.exe" <<'INNER'
#!/usr/bin/env bash
printf 'opencode2 %s\n' "$*" >>"${CUSTOM_OPENCODE_V2_BOOTSTRAP_LOG:?}"
if [[ "${1:-}" == "--version" ]]; then printf 'opencode v2.1.4\n'; fi
exit 0
INNER
chmod +x "$PACKAGE/bin/opencode.exe"
EOF
chmod +x "$FAKE_BIN/node"

# An unversioned legacy-shaped binary is intentionally present. The installer/wrapper must never
# probe or execute it: custom_opencode has exactly one OpenCode runtime, opencode2.
cat >"$FAKE_BIN/opencode" <<'EOF'
#!/usr/bin/env bash
printf 'FORBIDDEN-opencode %s\n' "$*" >>"${CUSTOM_OPENCODE_V2_BOOTSTRAP_LOG:?}"
exit 99
EOF
chmod +x "$FAKE_BIN/opencode"

env -u OPENCODE_CONFIG_DIR CUSTOM_OPENCODE_V2_BOOTSTRAP_LOG="$LOG" HOME="$HOME_DIR" PATH="$FAKE_BIN:/usr/bin:/bin" \
  bash "$COPY/scripts/install.sh" >"$TMP/install.out"

grep -Fxq "npm install --global --prefix $HOME_DIR/.local @opencode/cli@2.1.4" "$LOG"
grep -Fxq "node $HOME_DIR/.local/lib/node_modules/@opencode/cli/postinstall.mjs" "$LOG"
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

# Namespace upgrade: npm must release the old package's executable before install.
mkdir -p "$HOME_DIR/.local/lib/node_modules/@opencode-ai/cli"
printf '%s\n' '{"version":"0.0.0-beta-19271"}' >"$HOME_DIR/.local/lib/node_modules/@opencode-ai/cli/package.json"
printf '#!/usr/bin/env bash\necho "opencode v0.0.0-beta-19271"\n' >"$HOME_DIR/.local/bin/opencode2"
env -u OPENCODE_CONFIG_DIR CUSTOM_OPENCODE_V2_BOOTSTRAP_LOG="$LOG" HOME="$HOME_DIR" PATH="$FAKE_BIN:/usr/bin:/bin" \
  bash "$COPY/scripts/install.sh" >"$TMP/upgrade.out"
grep -Fxq "npm uninstall --global --prefix $HOME_DIR/.local @opencode-ai/cli" "$LOG"
[[ ! -e "$HOME_DIR/.local/lib/node_modules/@opencode-ai/cli/package.json" ]]
[[ $(CUSTOM_OPENCODE_V2_BOOTSTRAP_LOG="$LOG" "$HOME_DIR/.local/bin/opencode2" --version) == 'opencode v2.1.4' ]]

# The stable package also declares opencode; a user's V1/clipboard wrapper wins.
cp -p "$FAKE_BIN/opencode" "$HOME_DIR/.local/bin/opencode"
WRAPPER_MTIME=$(stat -c %y "$HOME_DIR/.local/bin/opencode")
mkdir -p "$HOME_DIR/.local/lib/node_modules/@opencode-ai/cli"
printf '%s\n' '{"version":"0.0.0-beta-19271"}' >"$HOME_DIR/.local/lib/node_modules/@opencode-ai/cli/package.json"
printf '#!/usr/bin/env bash\necho "opencode v0.0.0-beta-19271"\n' >"$HOME_DIR/.local/bin/opencode2"
env -u OPENCODE_CONFIG_DIR CUSTOM_OPENCODE_V2_BOOTSTRAP_LOG="$LOG" HOME="$HOME_DIR" PATH="$FAKE_BIN:/usr/bin:/bin" \
  bash "$COPY/scripts/install.sh" >"$TMP/wrapper-upgrade.out"
grep -Fxq "npm install --global --prefix $HOME_DIR/.local/share/custom-opencode/cli @opencode/cli@2.1.4" "$LOG"
cmp "$FAKE_BIN/opencode" "$HOME_DIR/.local/bin/opencode"
[[ $(stat -c %y "$HOME_DIR/.local/bin/opencode") == "$WRAPPER_MTIME" ]]
[[ $(CUSTOM_OPENCODE_V2_BOOTSTRAP_LOG="$LOG" "$HOME_DIR/.local/bin/opencode2" --version) == 'opencode v2.1.4' ]]

echo "OpenCode V2 bootstrap regression passed: clean install + legacy namespace upgrade + custom wrapper preservation + postinstall repair"
