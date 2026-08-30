#!/usr/bin/env bash
# Maintain the reviewed upstream Ponytail checkout used by OpenCode.
#
# The checkout stays outside the repository and is loaded directly from its
# OpenCode plugin entry point. No upstream skills, commands, or hooks are
# copied into the main OpenCode configuration tree.
set -euo pipefail

ponytail_validate_pin_tree() {
  local checkout=$1
  local pin=$2
  local relative mode

  for relative in \
    .opencode/plugins/ponytail.mjs \
    .opencode/plugins/ponytail-frontmatter.cjs \
    hooks/ponytail-config.js \
    hooks/ponytail-instructions.js \
    skills/ponytail/SKILL.md; do
    mode=$(git -C "$checkout" ls-tree -r "$pin" -- "$relative" | awk 'NF { print $1; exit }')
    case "$mode" in
      100644|100755) ;;
      *)
        echo "ponytail: required upstream file is missing or not regular at $pin: $relative" >&2
        return 1
        ;;
    esac
  done
}

ponytail_provision() {
  local upstream=${PONYTAIL_UPSTREAM_URL:-https://github.com/DietrichGebert/ponytail.git}
  local pin=${PONYTAIL_PIN_COMMIT:-2ed6c52c9d7e5e56942508591085fd45dea277d3}
  local branch=main
  local data_home=${XDG_DATA_HOME:-$HOME/.local/share}
  local checkout=${PONYTAIL_CHECKOUT_DIR:-$data_home/opencode/ponytail}
  local staging
  local current_branch current_head remote_head

  if [[ ! "$pin" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "ponytail: PONYTAIL_PIN_COMMIT must be a full 40-character commit SHA" >&2
    return 1
  fi
  if [[ "$checkout" != /* ]]; then
    echo "ponytail: checkout path must be absolute: $checkout" >&2
    return 1
  fi
  if [[ -L "$checkout" ]]; then
    echo "ponytail: checkout path must not be a symlink: $checkout" >&2
    return 1
  fi

  # A managed checkout always remains on local main. The pin may advance only
  # by fast-forward, so an update can never discard local commits or files.
  if [[ -d "$checkout/.git" && ! -L "$checkout/.git" ]]; then
    if ! git -C "$checkout" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      echo "ponytail: invalid git checkout: $checkout" >&2
      return 1
    fi
    if ! git -C "$checkout" diff --quiet || [[ -n "$(git -C "$checkout" status --porcelain)" ]]; then
      echo "ponytail: unexpected local changes in $checkout" >&2
      return 1
    fi

    local actual_origin
    actual_origin=$(git -C "$checkout" remote get-url origin 2>/dev/null) || {
      echo "ponytail: missing origin remote: $checkout" >&2
      return 1
    }
    if [[ "$actual_origin" != "$upstream" ]]; then
      echo "ponytail: origin URL mismatch (got '$actual_origin', expected '$upstream')" >&2
      return 1
    fi

    current_branch=$(git -C "$checkout" symbolic-ref --short HEAD 2>/dev/null || true)
    current_head=$(git -C "$checkout" rev-parse HEAD 2>/dev/null) || {
      echo "ponytail: cannot resolve HEAD: $checkout" >&2
      return 1
    }
    # Migrate the detached state produced by older versions only when it is
    # exactly the reviewed pin. Never invent a branch over another revision.
    if [[ -z "$current_branch" && "$current_head" == "$pin" ]]; then
      git -C "$checkout" switch --create "$branch" "$pin" >/dev/null
      current_branch=$branch
    fi
    if [[ "$current_branch" != "$branch" ]]; then
      echo "ponytail: expected branch '$branch', got '${current_branch:-detached HEAD}'" >&2
      return 1
    fi

    git -C "$checkout" fetch --no-tags origin "$branch" || {
      echo "ponytail: fetch from origin failed" >&2
      return 1
    }
    remote_head=$(git -C "$checkout" rev-parse "refs/remotes/origin/$branch" 2>/dev/null) || {
      echo "ponytail: origin/$branch is unavailable" >&2
      return 1
    }
    if ! git -C "$checkout" merge-base --is-ancestor "$pin" "$remote_head"; then
      echo "ponytail: pinned commit is not an ancestor of origin/$branch" >&2
      return 1
    fi
    # Validate the target tree before moving the checked-out branch. A bad pin
    # must not replace the last known-good revision before the final checks.
    ponytail_validate_pin_tree "$checkout" "$pin" || return 1
    if [[ "$current_head" != "$pin" ]]; then
      if ! git -C "$checkout" merge-base --is-ancestor "$current_head" "$pin"; then
        echo "ponytail: refusing non-fast-forward move from $current_head to $pin" >&2
        return 1
      fi
      git -C "$checkout" merge --ff-only "$pin" >/dev/null
    fi
  else
    if [[ -e "$checkout" ]]; then
      echo "ponytail: path exists but is not a managed checkout: $checkout" >&2
      return 1
    fi
    mkdir -p "$(dirname "$checkout")"
    staging="${checkout}.tmp.$$"
    if [[ -e "$staging" || -L "$staging" ]]; then
      echo "ponytail: staging path already exists: $staging" >&2
      return 1
    fi
    if ! git clone --branch "$branch" --single-branch --no-tags "$upstream" "$staging"; then
      rm -rf "$staging"
      echo "ponytail: initial clone failed" >&2
      return 1
    fi
    if ! git -C "$staging" cat-file -e "$pin^{commit}" 2>/dev/null || \
       ! git -C "$staging" merge-base --is-ancestor "$pin" "refs/remotes/origin/$branch"; then
      rm -rf "$staging"
      echo "ponytail: pinned commit is not available on origin/$branch" >&2
      return 1
    fi
    ponytail_validate_pin_tree "$staging" "$pin" || {
      rm -rf "$staging"
      return 1
    }
    # This is a new private staging checkout, so creating main at the reviewed
    # pin is safe and leaves the managed checkout attached to main.
    git -C "$staging" checkout --quiet -B "$branch" "$pin"
    if ! git -C "$staging" status --porcelain | grep -q .; then
      mv -- "$staging" "$checkout"
    else
      rm -rf "$staging"
      echo "ponytail: cloned checkout is unexpectedly dirty" >&2
      return 1
    fi
  fi

  for required in \
    "$checkout/.opencode/plugins/ponytail.mjs" \
    "$checkout/.opencode/plugins/ponytail-frontmatter.cjs" \
    "$checkout/hooks/ponytail-config.js" \
    "$checkout/hooks/ponytail-instructions.js" \
    "$checkout/skills/ponytail/SKILL.md"; do
    if [[ ! -f "$required" || -L "$required" ]]; then
      echo "ponytail: required upstream file is missing: $required" >&2
      return 1
    fi
  done
  if [[ "$(git -C "$checkout" rev-parse HEAD)" != "$pin" ]]; then
    echo "ponytail: checkout is not at pinned commit $pin" >&2
    return 1
  fi

  PONYTAIL_PROVISIONED_DIR=$checkout
  printf 'ponytail: ready at %s (commit %.12s)\n' "$checkout" "$pin"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  ponytail_provision
fi
