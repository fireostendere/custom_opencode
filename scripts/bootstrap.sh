#!/usr/bin/env bash
set -euo pipefail

DEFAULT_REPO=https://github.com/fireostendere/custom_opencode.git
DEFAULT_REF=main
DEFAULT_OPENCODE_PACKAGE=@opencode-ai/cli@0.0.0-beta-18743

MODE=install
REPO=$DEFAULT_REPO
REF=$DEFAULT_REF
INSTALL_DIR=${CUSTOM_OPENCODE_INSTALL_DIR:-"$HOME/.local/share/custom-opencode"}
ENV_SOURCE=
OPENCODE_PACKAGE=$DEFAULT_OPENCODE_PACKAGE
DRY_RUN=0
NON_INTERACTIVE=0
ALLOW_SUDO=0

usage() {
  cat <<'EOF'
Usage: bootstrap.sh [options]

  --repo URL              Git repository (default: official repository)
  --ref REF               Branch, tag, or full commit to install (default: main)
  --install-dir PATH      Checkout destination
  --env-file PATH         Initial .env source; never replaces an existing .env
  --opencode-package PKG  Exact OpenCode npm package pin
  --dry-run               Print changes without modifying the system
  --non-interactive       Never prompt; fail when input or consent is required
  --allow-sudo            Explicitly allow sudo for missing apt dependencies
  --doctor                Check prerequisites and local installation safety
  --status                Show the installed revision and service status
  --help                  Show this help
EOF
}

die() { printf 'bootstrap: %s\n' "$*" >&2; exit 1; }
note() { printf '==> %s\n' "$*"; }
quote_command() { printf '%q ' "$@"; printf '\n'; }
run() {
  if [[ "$DRY_RUN" == 1 ]]; then
    printf '+ '
    quote_command "$@"
  else
    "$@"
  fi
}

while (($#)); do
  case "$1" in
    --repo|--ref|--install-dir|--env-file|--opencode-package)
      (($# >= 2)) || die "$1 requires a value"
      case "$1" in
        --repo) REPO=$2 ;;
        --ref) REF=$2 ;;
        --install-dir) INSTALL_DIR=$2 ;;
        --env-file) ENV_SOURCE=$2 ;;
        --opencode-package) OPENCODE_PACKAGE=$2 ;;
      esac
      shift 2
      ;;
    --dry-run) DRY_RUN=1; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --allow-sudo) ALLOW_SUDO=1; shift ;;
    --doctor) MODE=doctor; shift ;;
    --status) MODE=status; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -n "$REPO" && -n "$REF" && -n "$OPENCODE_PACKAGE" ]] || die "repository, ref, and OpenCode package pin must not be empty"
[[ "$REPO" != -* && "$REF" != -* ]] || die "repository and ref must not start with '-'"
[[ "$OPENCODE_PACKAGE" =~ ^(@[A-Za-z0-9._-]+/)?[A-Za-z0-9._-]+@[0-9][A-Za-z0-9._+-]*$ ]] || die "OpenCode package must include one exact npm version pin"
[[ "$INSTALL_DIR" == /* ]] || die "install directory must be absolute: $INSTALL_DIR"
[[ "$INSTALL_DIR" != / && "$INSTALL_DIR" != "$HOME" ]] || die "unsafe install directory: $INSTALL_DIR"
[[ ! -L "$INSTALL_DIR" ]] || die "install directory must not be a symlink: $INSTALL_DIR"
if [[ -e "$INSTALL_DIR" ]]; then
  [[ -d "$INSTALL_DIR" ]] || die "install path is not a directory: $INSTALL_DIR"
  [[ $(stat -c %u "$INSTALL_DIR") == "$(id -u)" ]] || die "install directory must be owned by the current user"
fi
if [[ -n "$ENV_SOURCE" ]]; then
  [[ -f "$ENV_SOURCE" && ! -L "$ENV_SOURCE" ]] || die "env source must be a regular non-symlink file: $ENV_SOURCE"
fi

required=(git python3 node npm systemctl)
missing=()
for command_name in "${required[@]}"; do
  command -v "$command_name" >/dev/null 2>&1 || missing+=("$command_name")
done

install_missing() {
  ((${#missing[@]})) || return 0
  command -v apt-get >/dev/null 2>&1 || die "missing dependencies: ${missing[*]}; install them manually"
  command -v sudo >/dev/null 2>&1 || die "missing dependencies: ${missing[*]}; sudo is unavailable"
  [[ "$ALLOW_SUDO" == 1 ]] || die "missing dependencies: ${missing[*]}; rerun with --allow-sudo to explicitly permit apt via sudo"
  local packages=()
  local item
  for item in "${missing[@]}"; do
    case "$item" in
      git|python3|npm) packages+=("$item") ;;
      node) packages+=(nodejs) ;;
      systemctl) packages+=(systemd) ;;
    esac
  done
  note "Installing missing dependencies with explicit sudo consent"
  run sudo apt-get update
  run sudo apt-get install -y "${packages[@]}"
}

show_status() {
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    printf 'checkout: %s\n' "$INSTALL_DIR"
    printf 'revision: %s\n' "$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || printf unknown)"
    printf 'env: %s\n' "$([[ -f "$INSTALL_DIR/.env" && ! -L "$INSTALL_DIR/.env" ]] && printf present || printf missing)"
  else
    printf 'checkout: not installed (%s)\n' "$INSTALL_DIR"
  fi
  if command -v systemctl >/dev/null 2>&1; then
    printf 'service: %s\n' "$(systemctl --user is-active opencode-web-client.service 2>/dev/null || printf inactive)"
  fi
}

if [[ "$MODE" == status ]]; then
  show_status
  exit 0
fi

if [[ "$MODE" == doctor ]]; then
  ((${#missing[@]} == 0)) || die "missing dependencies: ${missing[*]}"
  if [[ -e "$INSTALL_DIR" && ! -d "$INSTALL_DIR/.git" ]]; then
    die "existing install directory is not a Git checkout"
  fi
  if [[ -f "$INSTALL_DIR/.env" ]]; then
    [[ ! -L "$INSTALL_DIR/.env" ]] || die "installed .env must not be a symlink"
    [[ $(stat -c %u "$INSTALL_DIR/.env") == "$(id -u)" ]] || die "installed .env must be owned by the current user"
  fi
  note "Doctor checks passed"
  show_status
  exit 0
fi

install_missing

if [[ -d "$INSTALL_DIR/.git" ]]; then
  origin=$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)
  [[ "$origin" == "$REPO" ]] || die "existing checkout origin differs from --repo: $origin"
  [[ -z "$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=no)" ]] || die "existing checkout has tracked changes; refusing to update"
  if [[ -f "$INSTALL_DIR/.env" ]]; then
    [[ ! -L "$INSTALL_DIR/.env" ]] || die "installed .env must not be a symlink"
    [[ $(stat -c %u "$INSTALL_DIR/.env") == "$(id -u)" ]] || die "installed .env must be owned by the current user"
  fi
  backup_root=${XDG_STATE_HOME:-"$HOME/.local/state"}/custom-opencode/bootstrap-backups
  backup_dir=$backup_root/$(date -u +%Y%m%dT%H%M%S.%NZ)-$(git -C "$INSTALL_DIR" rev-parse --short HEAD)
  note "Backing up current revision metadata and private environment"
  run mkdir -p -m 0700 "$backup_dir"
  if [[ "$DRY_RUN" == 0 ]]; then
    git -C "$INSTALL_DIR" rev-parse HEAD >"$backup_dir/revision"
  fi
  [[ ! -f "$INSTALL_DIR/.env" ]] || run cp -p "$INSTALL_DIR/.env" "$backup_dir/.env"
  note "Fetching pinned repository ref: $REF"
  run git -C "$INSTALL_DIR" fetch --prune -- origin "$REF"
  run git -C "$INSTALL_DIR" merge --ff-only FETCH_HEAD
else
  [[ ! -e "$INSTALL_DIR" || -z "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]] || die "existing install directory is not an empty Git checkout"
  note "Cloning pinned repository ref: $REF"
  run mkdir -p "$(dirname "$INSTALL_DIR")"
  run git clone --no-checkout -- "$REPO" "$INSTALL_DIR"
  run git -C "$INSTALL_DIR" fetch --prune -- origin "$REF"
  run git -C "$INSTALL_DIR" checkout --detach FETCH_HEAD
fi

if [[ "$DRY_RUN" == 1 ]]; then
  if [[ ! -f "$INSTALL_DIR/.env" && -n "$ENV_SOURCE" ]]; then run install -m 0600 "$ENV_SOURCE" "$INSTALL_DIR/.env"; fi
  run env "OPENCODE_CLI_PACKAGE=$OPENCODE_PACKAGE" bash "$INSTALL_DIR/scripts/verify.sh"
  run env "OPENCODE_CLI_PACKAGE=$OPENCODE_PACKAGE" bash "$INSTALL_DIR/scripts/install.sh"
  exit 0
fi

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  if [[ -n "$ENV_SOURCE" ]]; then
    install -m 0600 "$ENV_SOURCE" "$INSTALL_DIR/.env"
  else
    install -m 0600 "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
    if [[ "$NON_INTERACTIVE" == 1 ]]; then
      die "created $INSTALL_DIR/.env; configure it, then rerun bootstrap"
    fi
    printf 'Configure %s, then press Enter to continue (Ctrl+C to stop): ' "$INSTALL_DIR/.env" >&2
    read -r _
  fi
fi

[[ ! -L "$INSTALL_DIR/.env" && -f "$INSTALL_DIR/.env" ]] || die "installed .env must be a regular non-symlink file"
chmod 0600 "$INSTALL_DIR/.env"
note "Running repository verification"
env "OPENCODE_CLI_PACKAGE=$OPENCODE_PACKAGE" bash "$INSTALL_DIR/scripts/verify.sh"
note "Running reviewed installer"
env "OPENCODE_CLI_PACKAGE=$OPENCODE_PACKAGE" bash "$INSTALL_DIR/scripts/install.sh"
note "Installed revision $(git -C "$INSTALL_DIR" rev-parse HEAD)"
