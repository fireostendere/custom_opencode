#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
INLINE_JS="${TMPDIR:-/tmp}/custom-opencode-inline.js"
python3 -m py_compile "$ROOT/app/server.py"
python3 - "$ROOT/app/index.html" "$INLINE_JS" <<'PY'
from pathlib import Path
import re, sys
html = Path(sys.argv[1]).read_text(encoding="utf-8")
scripts = re.findall(r"<script>(.*?)</script>", html, re.S)
Path(sys.argv[2]).write_text("\n".join(scripts), encoding="utf-8")
if not scripts:
    raise SystemExit("No inline JavaScript found")
PY
node --check "$INLINE_JS"

python3 - "$ROOT" <<'PY'
from pathlib import Path
import re, sys
root = Path(sys.argv[1])
ipv4 = re.compile(r"(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)")
secret = re.compile(r"(?:gh[opsu]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})")
bad = []
for path in root.rglob("*"):
    if not path.is_file() or ".git" in path.parts or "__pycache__" in path.parts or path.name == ".env":
        continue
    text = path.read_text(encoding="utf-8", errors="ignore")
    if ipv4.search(text): bad.append(f"network address: {path.relative_to(root)}")
    if secret.search(text): bad.append(f"secret: {path.relative_to(root)}")
if bad:
    raise SystemExit("\n".join(bad))
print("Verification passed")
PY
