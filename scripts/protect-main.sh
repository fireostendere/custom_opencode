#!/usr/bin/env bash
# Explicit operator action. Requires an existing gh login with Administration
# write permission; never obtains tokens from unrelated files or environments.
set -euo pipefail
repo=${1:-fireostendere/custom_opencode}
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo 'Invalid owner/repository' >&2; exit 2; }
command -v gh >/dev/null || { echo 'GitHub CLI is required' >&2; exit 2; }
command -v python3 >/dev/null || { echo 'Python 3 is required' >&2; exit 2; }
umask 077
checks=$(mktemp)
trap 'rm -f "$checks"' EXIT
sha=$(gh api "repos/$repo/branches/main" --jq '.commit.sha')
# Pagination and the latest run for each check matter: a historical success
# must never override a newer failed or still-running attempt on this commit.
# gh older than 2.59 has no --slurp; --paginate emits one JSON document per
# page back-to-back, so the reader below decodes documents sequentially.
gh api "repos/$repo/commits/$sha/check-runs" --paginate > "$checks"
python3 - "$checks" "$sha" <<'PY'
import json
import sys

raw = open(sys.argv[1], encoding="utf-8").read()
decoder = json.JSONDecoder()
pages = []
idx = 0
while idx < len(raw):
    while idx < len(raw) and raw[idx].isspace():
        idx += 1
    if idx >= len(raw):
        break
    obj, idx = decoder.raw_decode(raw, idx)
    if isinstance(obj, list):
        pages.extend(obj)  # --slurp-style array of pages (offline fixtures)
    else:
        pages.append(obj)  # gh < 2.59 --paginate: concatenated documents
latest = {}
for page in pages:
    for check in page.get("check_runs", []):
        name = check.get("name")
        if name not in latest or int(check["id"]) > int(latest[name]["id"]):
            latest[name] = check
required = ("model-free-matrix", "native-clean-install", "native-budget-wire", "kernel-sandbox")
for name in required:
    check = latest.get(name, {})
    if (check.get("status") != "completed" or check.get("conclusion") != "success"
            or check.get("head_sha") != sys.argv[2]):
        sys.exit(f"Refusing protection activation: latest {name} has not passed on {sys.argv[2]}")
PY
current=$(gh api "repos/$repo/branches/main" --jq '.commit.sha')
[[ "$current" == "$sha" ]] || { echo 'main advanced while checks were inspected; retry against its new head' >&2; exit 1; }
gh api --method PUT "repos/$repo/branches/main/protection" --input - <<'JSON'
{"required_status_checks":{"strict":true,"contexts":["model-free-matrix","native-clean-install","native-budget-wire","kernel-sandbox"]},"enforce_admins":true,"required_pull_request_reviews":{"required_approving_review_count":0,"dismiss_stale_reviews":true},"restrictions":null,"required_conversation_resolution":true,"allow_force_pushes":false,"allow_deletions":false}
JSON
gh api "repos/$repo/branches/main/protection" --jq '{checks:.required_status_checks.contexts,enforceAdmins:.enforce_admins.enabled,forcePush:.allow_force_pushes.enabled,deletion:.allow_deletions.enabled}'
