#!/usr/bin/env bash
# Build an OpenCode fork checkout for this machine and print the binary path to
# set as OPENCODE_CLI_BINARY. The fork must sit on the pinned OpenCode version:
# the installer refuses a binary whose --version differs from the pin.
#
# usage: scripts/build-opencode-fork.sh [fork checkout] [output dir]
set -euo pipefail

SRC=${1:-$HOME/src/opencode}
OUT=${2:-$HOME/.local/share/opencode-fork}
BUN=${BUN:-$(command -v bun || true)}
if [[ ! -x "$BUN" ]]; then
  echo "bun is required (set BUN=/path/to/bun); $SRC/package.json pins its version" >&2
  exit 1
fi
VERSION=$(awk -F'"' '/"version"/ { print $4; exit }' "$SRC/packages/cli/package.json")
[[ -n "$VERSION" ]] || { echo "cannot read the CLI version from $SRC/packages/cli/package.json" >&2; exit 1; }

# The build shells out to bun itself.
(cd "$SRC/packages/cli" &&
  PATH="$(dirname "$BUN"):$PATH" OPENCODE_VERSION="$VERSION" OPENCODE_CHANNEL=latest \
    "$BUN" run script/build.ts --single --outdir="$OUT" >&2)
# The build rewrites packages/cli/package.json; leave the checkout clean.
git -C "$SRC" checkout -- packages/cli/package.json
find "$OUT" -path '*/bin/opencode' -type f -print -quit
