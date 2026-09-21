#!/usr/bin/env bash
set -euo pipefail

HOST="${DND_QWEN_HOST:-127.0.0.1}"
PORT="${DND_QWEN_PORT:-11434}"
MODEL_DIR="${DND_QWEN_MODEL_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/custom-opencode/models/qwen3.5-4b}"
MANIFEST="$MODEL_DIR/manifest.json"

if curl -fsS --max-time 1 "http://$HOST:$PORT/" >/dev/null 2>&1 || curl -fsS --max-time 1 "http://$HOST:$PORT/health" >/dev/null 2>&1; then
  exit 0
fi

backend="${DND_QWEN_BACKEND:-}"
if [[ -z "$backend" && -f "$MANIFEST" ]]; then
  backend="$(python3 - "$MANIFEST" <<'PY'
import json, sys
try: print(json.load(open(sys.argv[1], encoding="utf-8")).get("backend", ""))
except Exception: print("")
PY
)"
fi

case "$backend" in
  llama.cpp)
    model_path="$(python3 - "$MANIFEST" <<'PY'
import json, sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["path"])
PY
)"
    exec llama-server --host "$HOST" --port "$PORT" --model "$model_path" --ctx-size "${DND_QWEN_CONTEXT:-4096}" --parallel "${DND_QWEN_PARALLEL:-2}"
    ;;
  ollama)
    exec ollama serve
    ;;
  *)
    echo "D&D Qwen backend is not installed; run scripts/install-dnd-qwen.sh first." >&2
    exit 2
    ;;
esac
