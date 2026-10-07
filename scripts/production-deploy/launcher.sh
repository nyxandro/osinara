#!/bin/bash
# Stable systemd entrypoint of the Osinara deployment controller.
# Installed as /opt/osinara/bin/production-deploy.sh; validates the root-owned controller tree and
# hands every run to the controller version that `controller/current` selects.
set -Eeuo pipefail

readonly PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
readonly LAUNCHER_PATH="/opt/osinara/bin/production-deploy.sh"
readonly LAUNCHER_CONTROLLER_ROOT="/opt/osinara/bin/controller"
readonly LAUNCHER_CONTROLLER_NAME_PATTERN='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

launcher_fail() {
  printf '%s: %s\n' "$1" "$2" >&2
  exit 1
}

launcher_require_metadata() {
  local path="$1"
  local expected="$2"
  local actual="missing"
  [[ -e "$path" && ! -L "$path" ]] && actual="$(stat -c '%u:%g:%a' "$path")"
  [[ "$actual" == "$expected" ]] ||
    launcher_fail "DEPLOY_PATH_PERMISSIONS_INVALID" "${path} has ${actual}; expected ${expected}"
}

# Prints the physical directory of the selected version. The link holds a bare version name, so
# it can only point at a direct child of the controller root.
select_controller_dir() {
  local controller_root="$1"
  local name
  [[ -L "${controller_root}/current" ]] ||
    launcher_fail "DEPLOY_CONTROLLER_MISSING" "No controller version is selected in ${controller_root}"
  name="$(readlink "${controller_root}/current")"
  [[ "$name" =~ $LAUNCHER_CONTROLLER_NAME_PATTERN ]] ||
    launcher_fail "DEPLOY_CONTROLLER_INVALID" "controller/current must name a version directory"
  launcher_require_metadata "${controller_root}/${name}" "0:0:750"
  launcher_require_metadata "${controller_root}/${name}/main.sh" "0:0:640"
  # An empty main.sh would run as a silent success on every tick.
  [[ -s "${controller_root}/${name}/main.sh" ]] ||
    launcher_fail "DEPLOY_CONTROLLER_INVALID" "controller/${name}/main.sh is empty"
  printf '%s\n' "${controller_root}/${name}"
}

launch() {
  local controller_dir
  [[ "$(id -u)" -eq 0 ]] ||
    launcher_fail "DEPLOY_ROOT_REQUIRED" "production-deploy.sh must run as root"
  [[ "$(readlink -f "$0")" == "$LAUNCHER_PATH" ]] ||
    launcher_fail "DEPLOY_PATH_INVALID" "The deployment launcher must run from ${LAUNCHER_PATH}"
  launcher_require_metadata "/opt/osinara" "0:0:750"
  launcher_require_metadata "/opt/osinara/bin" "0:0:750"
  launcher_require_metadata "$LAUNCHER_PATH" "0:0:750"
  launcher_require_metadata "$LAUNCHER_CONTROLLER_ROOT" "0:0:750"
  controller_dir="$(select_controller_dir "$LAUNCHER_CONTROLLER_ROOT")"
  # The resolved path, not the link: a self-update may switch `current` while this run continues.
  exec /bin/bash "${controller_dir}/main.sh" "$@"
}

# Sourcing defines the functions only; the selection logic is tested without a root-owned tree.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  launch "$@"
fi
