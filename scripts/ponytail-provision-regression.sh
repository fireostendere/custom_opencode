#!/usr/bin/env bash
# Ponytail provisioning regression test.
#
# Creates a local fake upstream git repo, then exercises ponytail-provision.sh
# for: fresh clone, idempotent re-run, fast-forward update, wrong-origin
# rejection, dirty-state rejection, wrong-branch rejection, non-fast-forward
# rejection, and malformed/missing-pinned-commit rejection.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT="$ROOT/scripts/ponytail-provision.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# --- Build a fake upstream ponytail repo with the pinned commit ---
# First create a working repo with the ponytail structure
WORK="$TMP/ponytail-work"
mkdir -p "$WORK"
cd "$WORK"
git init -q --initial-branch=main
git config user.email "ponytail@test"
git config user.name "ponytail"
mkdir -p .opencode/plugins hooks skills/ponytail
cat > .opencode/plugins/ponytail.mjs <<'EOF'
export default async function ponytailStub() { return {}; }
EOF
cat > .opencode/plugins/ponytail-frontmatter.cjs <<'EOF'
module.exports = { parseCommandFile: () => null };
EOF
cat > hooks/ponytail-instructions.js <<'EOF'
module.exports = { getPonytailInstructions: (m) => '' };
EOF
cat > hooks/ponytail-config.js <<'EOF'
module.exports = { getDefaultMode: () => 'full', normalizePersistedMode: (m) => m };
EOF
cat > skills/ponytail/SKILL.md <<'EOF'
# Ponytail test skill
EOF
git add -A
git commit -q -m "initial ponytail"
PIN_COMMIT=$(git rev-parse HEAD)
cd "$ROOT"

# Now create a bare clone as the "upstream"
FAKE_UPSTREAM="$TMP/ponytail-upstream.git"
git clone -q --bare "$WORK" "$FAKE_UPSTREAM"

CHECKOUT="$TMP/ponytail-checkout"
PASS=0
FAIL=0

assert_ok() {
  local label=$1; shift
  if "$@"; then echo "  ok: $label"; PASS=$((PASS+1)); else echo "  FAIL: $label" >&2; FAIL=$((FAIL+1)); fi
}
assert_fail() {
  local label=$1; shift
  if "$@" >/dev/null 2>&1; then echo "  FAIL (should have failed): $label" >&2; FAIL=$((FAIL+1)); else echo "  ok: $label (rejected)"; PASS=$((PASS+1)); fi
}

echo "==> Fresh clone with pinned commit"
assert_ok "fresh clone succeeds" \
  env PONYTAIL_UPSTREAM_URL="$FAKE_UPSTREAM" \
      PONYTAIL_PIN_COMMIT="$PIN_COMMIT" \
      PONYTAIL_CHECKOUT_DIR="$CHECKOUT" \
  bash "$SCRIPT"
[[ -f "$CHECKOUT/.opencode/plugins/ponytail.mjs" ]] && { echo "  ok: plugin entry point exists"; PASS=$((PASS+1)); } || { echo "  FAIL: plugin entry point missing" >&2; FAIL=$((FAIL+1)); }

echo "==> Idempotent re-run"
assert_ok "re-run on existing checkout" \
  env PONYTAIL_UPSTREAM_URL="$FAKE_UPSTREAM" \
      PONYTAIL_PIN_COMMIT="$PIN_COMMIT" \
      PONYTAIL_CHECKOUT_DIR="$CHECKOUT" \
  bash "$SCRIPT"

echo "==> Fast-forward update"
echo "updated" >> "$WORK/.opencode/plugins/ponytail.mjs"
( cd "$WORK" && git add -A && git commit -q -m "fast-forward update" )
NEXT_PIN=$(git -C "$WORK" rev-parse HEAD)
git --git-dir="$FAKE_UPSTREAM" fetch -q "$WORK" main:main
assert_ok "advances to a newer pinned commit" \
  env PONYTAIL_UPSTREAM_URL="$FAKE_UPSTREAM" \
      PONYTAIL_PIN_COMMIT="$NEXT_PIN" \
      PONYTAIL_CHECKOUT_DIR="$CHECKOUT" \
  bash "$SCRIPT"
[[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$NEXT_PIN" ]] && { echo "  ok: checkout advanced by fast-forward"; PASS=$((PASS+1)); } || { echo "  FAIL: checkout did not advance by fast-forward" >&2; FAIL=$((FAIL+1)); }

echo "==> Reject invalid target tree without mutating checkout"
rm -f "$WORK/hooks/ponytail-instructions.js"
( cd "$WORK" && git add -A && git commit -q -m "invalid ponytail tree" )
BROKEN_PIN=$(git -C "$WORK" rev-parse HEAD)
git --git-dir="$FAKE_UPSTREAM" fetch -q "$WORK" main:main
assert_fail "rejects a pin missing a required file" \
  env PONYTAIL_UPSTREAM_URL="$FAKE_UPSTREAM" \
      PONYTAIL_PIN_COMMIT="$BROKEN_PIN" \
      PONYTAIL_CHECKOUT_DIR="$CHECKOUT" \
  bash "$SCRIPT"
[[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$NEXT_PIN" ]] && { echo "  ok: invalid pin did not mutate checkout"; PASS=$((PASS+1)); } || { echo "  FAIL: invalid pin mutated checkout" >&2; FAIL=$((FAIL+1)); }

echo "==> Reject wrong origin URL"
assert_fail "rejects mismatched origin" \
  env PONYTAIL_UPSTREAM_URL="https://evil.example/ponytail.git" \
      PONYTAIL_PIN_COMMIT="$PIN_COMMIT" \
      PONYTAIL_CHECKOUT_DIR="$CHECKOUT" \
  bash "$SCRIPT"

echo "==> Reject dirty checkout"
echo "dirty" > "$CHECKOUT/LOCAL_CHANGES"
assert_fail "rejects dirty working tree" \
  env PONYTAIL_UPSTREAM_URL="$FAKE_UPSTREAM" \
      PONYTAIL_PIN_COMMIT="$PIN_COMMIT" \
      PONYTAIL_CHECKOUT_DIR="$CHECKOUT" \
  bash "$SCRIPT"
rm -f "$CHECKOUT/LOCAL_CHANGES"

echo "==> Reject wrong branch"
( cd "$CHECKOUT" && git checkout -q -b not-main )
assert_fail "rejects non-main branch" \
  env PONYTAIL_UPSTREAM_URL="$FAKE_UPSTREAM" \
      PONYTAIL_PIN_COMMIT="$PIN_COMMIT" \
      PONYTAIL_CHECKOUT_DIR="$CHECKOUT" \
  bash "$SCRIPT"
( cd "$CHECKOUT" && git checkout -q main )

echo "==> Reject non-fast-forward pin"
assert_fail "rejects moving back to an older pin" \
  env PONYTAIL_UPSTREAM_URL="$FAKE_UPSTREAM" \
      PONYTAIL_PIN_COMMIT="$PIN_COMMIT" \
      PONYTAIL_CHECKOUT_DIR="$CHECKOUT" \
  bash "$SCRIPT"

echo "==> Reject malformed pinned commit"
assert_fail "rejects a short commit hash" \
  env PONYTAIL_UPSTREAM_URL="$FAKE_UPSTREAM" \
      PONYTAIL_PIN_COMMIT="${NEXT_PIN:0:12}" \
      PONYTAIL_CHECKOUT_DIR="$CHECKOUT" \
  bash "$SCRIPT"

echo "==> Reject missing pinned commit"
assert_fail "rejects unknown commit hash" \
  env PONYTAIL_UPSTREAM_URL="$FAKE_UPSTREAM" \
      PONYTAIL_PIN_COMMIT="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" \
      PONYTAIL_CHECKOUT_DIR="$CHECKOUT" \
  bash "$SCRIPT"

echo
if [[ $FAIL -gt 0 ]]; then
  echo "ponytail-provision regression: FAIL ($PASS passed, $FAIL failed)" >&2
  exit 1
fi
echo "ponytail-provision regression: PASS ($PASS/$PASS)"
