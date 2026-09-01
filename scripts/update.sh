#!/usr/bin/env bash
set -euo pipefail

SOURCE=${BASH_SOURCE[0]}
if command -v readlink >/dev/null 2>&1; then
  RESOLVED=$(readlink -f "$SOURCE" 2>/dev/null || true)
  if [[ -n "$RESOLVED" ]]; then
    SOURCE=$RESOLVED
  fi
fi
ROOT=$(cd "$(dirname "$SOURCE")/.." && pwd)
cd "$ROOT"

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "custom-opencode-update could not locate the Git checkout." >&2
  echo "Resolved updater path: $SOURCE" >&2
  echo "Expected repository root: $ROOT" >&2
  exit 1
fi

# Production updates are intentionally pinned to origin/main. Avoid `git pull`
# here: a malformed or duplicated branch.*.merge entry in local Git config can
# make pull try to fast-forward multiple branches at once.
git fetch --prune origin main
git merge --ff-only FETCH_HEAD

# Existing installs may predate the explicit-copy TUI mode. Preserve any user
# override, but default old .env files to the same behavior as fresh installs:
# mouse controls stay enabled and Ctrl+C owns copying selected text instead of
# copy-on-mouse-up clearing the OpenTUI selection lifecycle.
ENV_FILE="$ROOT/.env"
if [[ -f "$ENV_FILE" ]] && ! grep -q '^OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT=' "$ENV_FILE"; then
  cat >>"$ENV_FILE" <<'EOF'

# Keep TUI mouse controls active; copy selected text explicitly with Ctrl+C.
OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT=1
EOF
fi

"$ROOT/scripts/install.sh"
echo "Updated from origin/main and restarted the web/shared OpenCode services."
