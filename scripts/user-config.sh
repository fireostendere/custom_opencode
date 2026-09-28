# Shared environment loading for custom_opencode entry points. Source it.
#
# The repository .env is local: secrets and machine-specific values. The
# optional CUSTOM_OPENCODE_USER_CONFIG (set in .env) names a separate private
# checkout that owns personal, non-secret configuration: settings.env, an
# opencode.overlay.json, prompts, plugins, themes and Tool Fabric policy.
# settings.env is loaded first and .env again on top, so local values win.
# systemd reads settings.env too, so keep it to plain KEY=VALUE lines.

# Print the canonical private config directory; nothing when it is unset.
custom_opencode_user_config_dir() {
  local root=$1 dir=${CUSTOM_OPENCODE_USER_CONFIG:-}
  [[ -n "$dir" ]] || return 0
  [[ "$dir" == /* ]] || dir="$root/$dir"
  if [[ ! -d "$dir" ]]; then
    echo "CUSTOM_OPENCODE_USER_CONFIG is not a directory: $dir" >&2
    return 1
  fi
  if [[ $(stat -c %u "$dir") != $(id -u) ]]; then
    echo "CUSTOM_OPENCODE_USER_CONFIG must be owned by the current user: $dir" >&2
    return 1
  fi
  local settings="$dir/settings.env"
  if [[ -L "$settings" || ( -e "$settings" && ! -f "$settings" ) ]]; then
    echo "refusing unsafe user settings file: $settings" >&2
    return 1
  fi
  if [[ -f "$settings" && $(stat -c %u "$settings") != $(id -u) ]]; then
    echo "user settings file must be owned by the current user: $settings" >&2
    return 1
  fi
  (cd "$dir" && pwd -P)
}

# Load .env, then the private settings.env under it, then .env again on top.
custom_opencode_load_env() {
  local _co_env="$1/.env" _co_config
  set -a
  source "$_co_env"
  set +a
  _co_config=$(custom_opencode_user_config_dir "$1") || return 1
  if [[ -n "$_co_config" ]]; then
    if [[ -f "$_co_config/settings.env" ]]; then
      set -a
      source "$_co_config/settings.env"
      source "$_co_env"
      set +a
    fi
    export CUSTOM_OPENCODE_USER_CONFIG="$_co_config"
  fi
}
