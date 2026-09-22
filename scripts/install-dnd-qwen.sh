#!/usr/bin/env bash
set -euo pipefail

# Pinned, non-secret local router model. The model is never stored in Git.
MODEL_REPO="${DND_QWEN_MODEL_REPO:-openresearchtools/Qwen3.5-4B-Instruct-GGUF}"
MODEL_REVISION="${DND_QWEN_MODEL_REVISION:-4fa3cee}"
MODEL_FILE="${DND_QWEN_MODEL_FILE:-qwen3.5-4b-instruct-Q4_K_M.gguf}"
MODEL_TAG="${DND_QWEN_MODEL_TAG:-hf://${MODEL_REPO}:${MODEL_REVISION}/${MODEL_FILE}}"
CACHE_ROOT="${DND_QWEN_MODEL_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/custom-opencode/models/qwen3.5-4b}"
MODEL_PATH="$CACHE_ROOT/$MODEL_FILE"
MANIFEST="$CACHE_ROOT/manifest.json"
OLLAMA_MODEL="${DND_QWEN_OLLAMA_MODEL:-custom-opencode-qwen35-4b-q4km}"

json() {
  python3 - "$@" <<'PY'
import json, sys
print(json.dumps(json.loads(sys.argv[1]), ensure_ascii=False, indent=2))
PY
}

detect_backend() {
  if command -v llama-server >/dev/null 2>&1; then
    echo "llama.cpp"
  elif command -v ollama >/dev/null 2>&1; then
    echo "ollama"
  else
    echo "unavailable"
  fi
}

manifest_matches() {
  [[ -s "$MODEL_PATH" && -f "$MANIFEST" ]] || return 1
  python3 - "$MANIFEST" "$MODEL_REPO" "$MODEL_REVISION" "$MODEL_FILE" <<'PY'
import json, sys
try:
    row = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if [row.get("repo"), row.get("revision"), row.get("filename")] == sys.argv[2:] else 1)
PY
}

write_manifest() {
  mkdir -p "$CACHE_ROOT"
  python3 - "$MANIFEST" "$MODEL_REPO" "$MODEL_REVISION" "$MODEL_FILE" "$MODEL_PATH" "$(detect_backend)" <<'PY'
import json, os, sys, tempfile
target, repo, revision, filename, path, backend = sys.argv[1:]
row = {"repo": repo, "revision": revision, "filename": filename, "path": os.path.abspath(path), "backend": backend, "quant": "Q4_K_M"}
fd, temporary = tempfile.mkstemp(prefix=".manifest.", dir=os.path.dirname(target), text=True)
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    json.dump(row, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
os.replace(temporary, target)
PY
}

dry_run() {
  local backend
  backend="$(detect_backend)"
  json "{\"backend\":\"$backend\",\"repo\":\"$MODEL_REPO\",\"revision\":\"$MODEL_REVISION\",\"filename\":\"$MODEL_FILE\",\"path\":\"$MODEL_PATH\",\"resident\":true,\"host\":\"127.0.0.1\"}"
}

if [[ "${1:-}" == "--dry-run" || "${1:-}" == "--probe" ]]; then
  dry_run
  exit 0
fi

backend="$(detect_backend)"
[[ "$backend" != "unavailable" ]] || {
  echo "No llama-server or Ollama executable found; install one before Qwen provisioning." >&2
  exit 2
}

if [[ "$backend" == "ollama" ]]; then
  if ! ollama list >/dev/null 2>&1; then
    echo "Ollama daemon is unavailable; start it and rerun this idempotent installer." >&2
    exit 3
  fi
  mkdir -p "$CACHE_ROOT"
  if ! manifest_matches; then
    url="https://huggingface.co/$MODEL_REPO/resolve/$MODEL_REVISION/$MODEL_FILE?download=true"
    temporary="$MODEL_PATH.part"
    curl --fail --location --retry 2 --continue-at - "$url" -o "$temporary"
    mv "$temporary" "$MODEL_PATH"
  fi
  modelfile="$CACHE_ROOT/Modelfile"
  printf 'FROM %s\nPARAMETER num_ctx 4096\nPARAMETER temperature 0\n' "$MODEL_PATH" > "$modelfile"
  if ! ollama show "$OLLAMA_MODEL" >/dev/null 2>&1; then
    ollama create "$OLLAMA_MODEL" -f "$modelfile"
  fi
  write_manifest
  echo "Qwen router model ready via Ollama: $OLLAMA_MODEL (source $MODEL_REPO@$MODEL_REVISION/$MODEL_FILE)"
  exit 0
fi

mkdir -p "$CACHE_ROOT"
if ! manifest_matches; then
  url="https://huggingface.co/$MODEL_REPO/resolve/$MODEL_REVISION/$MODEL_FILE?download=true"
  temporary="$MODEL_PATH.part"
  curl --fail --location --retry 2 --continue-at - "$url" -o "$temporary"
  mv "$temporary" "$MODEL_PATH"
  write_manifest
else
  echo "Qwen router model already present; no download needed."
fi
echo "Qwen router model ready: $MODEL_PATH"
