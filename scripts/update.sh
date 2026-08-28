#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

git pull --ff-only
"$ROOT/scripts/install.sh"
echo "Updated from Git and restarted the web/shared OpenCode services."
