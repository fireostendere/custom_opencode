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

if "$CLI" run --agent plan >/dev/null 2>&1; then
  echo "[FAIL] cli-wrapper: bare isolated plan was accepted" >&2
  exit 1
fi
for ref in 'missing-provider' 'provider/' '/model' 'provider/model#' 'provider/model#two#variants' 'provider/model with-space'; do
  if "$CLI" run --model="$ref" --agent=plan >/dev/null 2>&1; then
    echo "[FAIL] cli-wrapper: malformed isolated-plan model was accepted: $ref" >&2
    exit 1
  fi
done
if "$CLI" run --model --agent plan >/dev/null 2>&1; then
  echo "[FAIL] cli-wrapper: missing --model value was accepted" >&2
  exit 1
fi
# A final option must be diagnosed by the wrapper, not terminate its parser.
for args in '--agent plan --model'; do
  if "$CLI" run $args >/dev/null 2>&1; then
    echo "[FAIL] cli-wrapper: final malformed option was accepted: $args" >&2
    exit 1
  fi
done
for ref in bailian-cli/qwen3.8-orchestrated openai/gpt-5.6-sol-orchestrated 'custom/direct#high'; do
  "$CLI" run --model "$ref" --agent plan --help >/dev/null
  "$CLI" run --agent=plan --model="$ref" --help >/dev/null
done
"$CLI" run --agent build --model=not-a-model-ref --help >/dev/null
echo "[PASS] cli-wrapper: isolated plans require an exact model ref"
