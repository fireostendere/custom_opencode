#!/usr/bin/env bash
set -euo pipefail
FABRIC_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
FABRIC_PYTHON=${OPENCODE_FABRIC_PYTHON:-python3}
exec "$FABRIC_PYTHON" "$FABRIC_ROOT/app/tool_fabric_mcp.py" "$@"
