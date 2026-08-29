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

git pull --ff-only
"$ROOT/scripts/install.sh"
echo "Updated from Git and restarted the web/shared OpenCode services."
