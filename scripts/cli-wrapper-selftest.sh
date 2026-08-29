#!/usr/bin/env bash
set -euo pipefail

CLI=${1:-"$HOME/.local/bin/custom-opencode"}
if [[ ! -x "$CLI" ]]; then
  echo "[FAIL] cli-wrapper: executable not found: $CLI" >&2
  exit 1
fi

OUTPUT=""
if ! OUTPUT=$(timeout 15s "$CLI" --version 2>&1); then
  echo "[FAIL] cli-wrapper: custom-opencode --version failed" >&2
  [[ -n "$OUTPUT" ]] && printf '%s\n' "$OUTPUT" >&2
  exit 1
fi

VERSION=$(printf '%s\n' "$OUTPUT" | head -n 1)
echo "[PASS] cli-wrapper: ${VERSION:-version command succeeded}"
