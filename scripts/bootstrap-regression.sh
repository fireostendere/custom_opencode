#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
SOURCE=$TMP/source
INSTALL=$TMP/install
HOME_DIR=$TMP/home
ENV_SOURCE=$TMP/source.env
LOG=$TMP/actions.log
mkdir -p "$SOURCE/scripts" "$HOME_DIR"

cat >"$SOURCE/.env.example" <<'EOF'
OPENCODE_SERVER_PASSWORD=CHANGE_ME
EOF
cat >"$SOURCE/scripts/verify.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'verify %s\n' "${OPENCODE_CLI_PACKAGE:?}" >>"${BOOTSTRAP_TEST_LOG:?}"
EOF
cat >"$SOURCE/scripts/install.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'install %s\n' "${OPENCODE_CLI_PACKAGE:?}" >>"${BOOTSTRAP_TEST_LOG:?}"
EOF
chmod +x "$SOURCE/scripts/verify.sh" "$SOURCE/scripts/install.sh"
git -C "$SOURCE" init -q --initial-branch=main
git -C "$SOURCE" config user.email bootstrap@test
git -C "$SOURCE" config user.name bootstrap
git -C "$SOURCE" add -A
git -C "$SOURCE" commit -qm initial
FIRST=$(git -C "$SOURCE" rev-parse HEAD)
printf '%s\n' 'OPENCODE_SERVER_PASSWORD=secret-one' >"$ENV_SOURCE"
chmod 0600 "$ENV_SOURCE"

HOME="$HOME_DIR" BOOTSTRAP_TEST_LOG="$LOG" bash "$ROOT/scripts/bootstrap.sh" \
  --repo "$SOURCE" --ref "$FIRST" --install-dir "$INSTALL" --env-file "$ENV_SOURCE" \
  --opencode-package '@opencode-ai/cli@1.2.3-test' --non-interactive
grep -Fxq 'verify @opencode-ai/cli@1.2.3-test' "$LOG"
grep -Fxq 'install @opencode-ai/cli@1.2.3-test' "$LOG"
grep -Fxq 'OPENCODE_SERVER_PASSWORD=secret-one' "$INSTALL/.env"
[[ $(stat -c %a "$INSTALL/.env") == 600 ]]

printf '%s\n' updated >"$SOURCE/version.txt"
git -C "$SOURCE" add version.txt
git -C "$SOURCE" commit -qm updated
SECOND=$(git -C "$SOURCE" rev-parse HEAD)
printf '%s\n' 'OPENCODE_SERVER_PASSWORD=must-not-replace' >"$ENV_SOURCE"
HOME="$HOME_DIR" BOOTSTRAP_TEST_LOG="$LOG" bash "$ROOT/scripts/bootstrap.sh" \
  --repo "$SOURCE" --ref "$SECOND" --install-dir "$INSTALL" --env-file "$ENV_SOURCE" \
  --opencode-package '@opencode-ai/cli@1.2.3-test' --non-interactive
[[ $(git -C "$INSTALL" rev-parse HEAD) == "$SECOND" ]]
grep -Fxq 'OPENCODE_SERVER_PASSWORD=secret-one' "$INSTALL/.env"
BACKUP=$(find "$HOME_DIR/.local/state/custom-opencode/bootstrap-backups" -name revision -print -quit)
[[ -n "$BACKUP" ]]
grep -Fxq "$FIRST" "$BACKUP"
grep -Fxq 'OPENCODE_SERVER_PASSWORD=secret-one' "$(dirname "$BACKUP")/.env"

DRY=$TMP/dry-install
HOME="$HOME_DIR" bash "$ROOT/scripts/bootstrap.sh" --repo "$SOURCE" --ref "$SECOND" \
  --install-dir "$DRY" --env-file "$ENV_SOURCE" --dry-run --non-interactive >"$TMP/dry.out"
[[ ! -e "$DRY" ]]
grep -Fq 'git clone --no-checkout --' "$TMP/dry.out"
grep -Fq 'scripts/install.sh' "$TMP/dry.out"

UNCONFIGURED=$TMP/unconfigured
if HOME="$HOME_DIR" BOOTSTRAP_TEST_LOG="$LOG" bash "$ROOT/scripts/bootstrap.sh" \
  --repo "$SOURCE" --ref "$SECOND" --install-dir "$UNCONFIGURED" --non-interactive >"$TMP/unconfigured.out" 2>&1; then
  echo 'Non-interactive bootstrap continued with an unconfigured environment' >&2
  exit 1
fi
grep -Fq 'configure it, then rerun bootstrap' "$TMP/unconfigured.out"
grep -Fxq 'OPENCODE_SERVER_PASSWORD=CHANGE_ME' "$UNCONFIGURED/.env"

if HOME="$HOME_DIR" bash "$ROOT/scripts/bootstrap.sh" --repo -unsafe --dry-run >"$TMP/unsafe.out" 2>&1; then
  echo 'Bootstrap accepted an option-like repository' >&2
  exit 1
fi
grep -Fq "repository and ref must not start with '-'" "$TMP/unsafe.out"
if HOME="$HOME_DIR" bash "$ROOT/scripts/bootstrap.sh" --opencode-package '@opencode-ai/cli@latest' --dry-run >"$TMP/latest.out" 2>&1; then
  echo 'Bootstrap accepted a floating npm version' >&2
  exit 1
fi
grep -Fq 'exact npm version pin' "$TMP/latest.out"

HOME="$HOME_DIR" bash "$ROOT/scripts/bootstrap.sh" --install-dir "$INSTALL" --status >"$TMP/status.out"
grep -Fq "revision: $SECOND" "$TMP/status.out"
HOME="$HOME_DIR" bash "$ROOT/scripts/bootstrap.sh" --install-dir "$INSTALL" --doctor >"$TMP/doctor.out"
grep -Fq 'Doctor checks passed' "$TMP/doctor.out"

echo 'Bootstrap regression passed: pin + dry-run + preserved env + backup + doctor/status'
