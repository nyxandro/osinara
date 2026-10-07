#!/bin/bash
# Deployment controller self-update from the release being deployed.
# The approved release's app image, bound by digest to the approved manifest, carries the
# controller that has to deploy it. A different copy is placed beside the running one, checks the
# host with its own rules, is selected by one rename, and takes the claimed release over in a fresh
# process.
#
# Cross-version interface: the running controller starts a newer one as `main.sh --preflight` and
# `launcher --resume PROPOSAL LEASE`. Every controller version must keep accepting both forms.

readonly CONTROLLER_IMAGE_DIR="/app/deploy/controller"
readonly CONTROLLER_FILE_PATTERN='^[a-z0-9-]+\.(sh|jq)$'
readonly REQUIRED_CONTROLLER_FILES=(launcher.sh main.sh)
CONTROLLER_STAGING_DIR=""
RESUMED_AFTER_SELF_UPDATE=0

extract_release_controller() {
  local image="$1"
  local target="$2"
  docker run --rm --network none --entrypoint /bin/tar "$image" -c -C "$CONTROLLER_IMAGE_DIR" . |
    tar -x --no-same-owner --no-same-permissions -C "$target"
}

# A controller is flat: regular top-level modules and filters, each module valid shell.
validate_controller_tree() {
  local directory="$1"
  local path name
  while IFS= read -r -d '' path; do
    name="${path##*/}"
    if [[ -L "$path" || ! -f "$path" || ! "$name" =~ $CONTROLLER_FILE_PATTERN ]]; then
      fail "DEPLOY_CONTROLLER_RELEASE_INVALID" "Release controller has an unexpected entry: ${name}"
      return 1
    fi
    if [[ "$name" == *.sh ]] && ! bash -n "$path"; then
      fail "DEPLOY_CONTROLLER_RELEASE_INVALID" "Release controller module is not valid shell: ${name}"
      return 1
    fi
  done < <(find "$directory" -mindepth 1 -print0)
  for name in "${REQUIRED_CONTROLLER_FILES[@]}"; do
    if [[ ! -s "${directory}/${name}" || -L "${directory}/${name}" ]]; then
      fail "DEPLOY_CONTROLLER_RELEASE_INVALID" "Release controller has no ${name}"
      return 1
    fi
  done
}

# Digest of every top-level file in name order, comparable between any two controller directories.
controller_tree_listing() {
  local directory="$1"
  local -a names=()
  mapfile -d '' -t names < <(find "$directory" -mindepth 1 -maxdepth 1 -type f -printf '%f\0' |
    LC_ALL=C sort -z)
  if ((${#names[@]} == 0)); then
    fail "DEPLOY_CONTROLLER_RELEASE_INVALID" "Controller directory is empty: ${directory}"
    return 1
  fi
  (cd -- "$directory" && sha256sum -- "${names[@]}")
}

# Places a validated candidate as `v<version>` without selecting it. The bytes reach the disk
# before anything points at them, so a power loss cannot leave `current` naming empty files.
install_release_controller() {
  local candidate="$1"
  local controller_root="$2"
  local version="$3"
  local final="${controller_root}/v${version}"
  if [[ -e "$final" || -L "$final" ]]; then
    fail "DEPLOY_CONTROLLER_DIR_EXISTS" "Controller directory already exists: v${version}"
    return 1
  fi
  find "$candidate" -mindepth 1 -maxdepth 1 -type f -exec chmod 0640 {} +
  chmod 0750 "$candidate"
  mv -T "$candidate" "$final"
  sync -- "$final"/* "$final" "$controller_root"
}

# The placed controller checks this host with its own rules before it is selected: a controller
# that refused the host after the handover could not record the claim it took over.
preflight_release_controller() {
  local controller_root="$1"
  local version="$2"
  local directory="${controller_root}/v${version}"
  if ! bash "${directory}/main.sh" --preflight; then
    # Never selected and never run beyond its checks, so nothing else can depend on it.
    rm -rf -- "$directory"
    fail "DEPLOY_CONTROLLER_PREFLIGHT_FAILED" "The controller of v${version} does not accept this host"
    return 1
  fi
}

# Each switch is one rename and the launcher contract is stable, so a stop between them still
# leaves a runnable launcher and controller pair.
select_release_controller() {
  local controller_root="$1"
  local launcher="$2"
  local version="$3"
  local temporary_link="${controller_root}/.current.tmp.$$"
  local temporary_launcher="${launcher%/*}/.production-deploy.sh.tmp.$$"
  install -m 0750 "${controller_root}/v${version}/launcher.sh" "$temporary_launcher"
  sync -- "$temporary_launcher"
  ln -s "v${version}" "$temporary_link"
  mv -Tf "$temporary_link" "${controller_root}/current"
  mv -f "$temporary_launcher" "$launcher"
  sync -- "$controller_root" "${launcher%/*}"
}

# Makes sure the controller deploying the claimed release is the one that release ships. Runs
# after the release is validated against the approved manifest, so APP_IMAGE is trusted here.
ensure_release_controller() {
  local controller_root="$1"
  local launcher="$2"
  local running_listing candidate_listing
  docker pull --quiet "$APP_IMAGE"
  CONTROLLER_STAGING_DIR="$(mktemp -d "${controller_root}/.staging.XXXXXX")"
  extract_release_controller "$APP_IMAGE" "$CONTROLLER_STAGING_DIR"
  validate_controller_tree "$CONTROLLER_STAGING_DIR"
  running_listing="$(controller_tree_listing "$CONTROLLER_DIR")"
  candidate_listing="$(controller_tree_listing "$CONTROLLER_STAGING_DIR")"
  if [[ "$running_listing" == "$candidate_listing" ]] &&
    cmp --silent "$launcher" "${CONTROLLER_STAGING_DIR}/launcher.sh"; then
    rm -rf -- "$CONTROLLER_STAGING_DIR"
    CONTROLLER_STAGING_DIR=""
    return 0
  fi

  # The controller that took the release over must be exactly the one the release carries.
  if [[ "$RESUMED_AFTER_SELF_UPDATE" -eq 1 ]]; then
    fail "DEPLOY_CONTROLLER_UPDATE_LOOP" "Release controller still differs after it took the release over"
    return 1
  fi
  install_release_controller "$CONTROLLER_STAGING_DIR" "$controller_root" "$REQUESTED_VERSION"
  CONTROLLER_STAGING_DIR=""
  preflight_release_controller "$controller_root" "$REQUESTED_VERSION"
  select_release_controller "$controller_root" "$launcher" "$REQUESTED_VERSION"
  log_event "DEPLOY_CONTROLLER_UPDATED" \
    "Installed the controller of v${REQUESTED_VERSION}; it takes the claimed release over"
  hand_over_to_release_controller "$launcher"
}

# Only the claim identity crosses the exec. The lock stays held on the inherited descriptor, and
# the new controller re-reads and re-validates everything else itself.
hand_over_to_release_controller() {
  local launcher="$1"
  local status=0
  if [[ ! -f "$launcher" || ! -x "$launcher" ]]; then
    fail "DEPLOY_CONTROLLER_HANDOVER_FAILED" "Release controller launcher is not executable: ${launcher}"
    return 1
  fi
  # Under errexit bash exits on a failed exec even with execfail. Without errexit and inside an
  # `||` list a failed exec returns here, so the failure is recorded against the claim below.
  shopt -s execfail
  set +e
  exec "$launcher" --resume "$PROPOSAL_ID" "$LEASE_TOKEN" || status=$?
  set -e
  fail "DEPLOY_CONTROLLER_HANDOVER_FAILED" "Could not start the release controller (exit ${status})"
  return 1
}

# A resumed controller was execed by its predecessor with the deployment lock held on descriptor 9.
require_inherited_deploy_lock() {
  local lock_file="$1"
  if [[ "$(readlink "/proc/$$/fd/9" 2>/dev/null)" != "$lock_file" ]] || ! flock -n 9; then
    fail "DEPLOY_RESUME_LOCK_INVALID" "A resumed deployment must inherit the deployment lock"
    return 1
  fi
}

# Keeps the selected controller and the newest other one: after a failed release the previous
# controller is still on disk to compare against. Runs only after terminal success, so a removal
# failure is housekeeping and is recorded instead of changing the result.
prune_retired_controllers() {
  local controller_root="$1"
  local launcher="$2"
  local current name path
  local -a others=()
  current="$(readlink "${controller_root}/current")"
  while IFS= read -r name; do
    if [[ "$name" =~ $RELEASE_DIRECTORY_NAME_PATTERN && "$name" != "$current" ]]; then
      others+=("$name")
    fi
  done < <(find "$controller_root" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -V)

  local index
  for ((index = 0; index < ${#others[@]} - 1; index += 1)); do
    if rm -rf -- "${controller_root:?}/${others[index]}"; then
      log_event "DEPLOY_CONTROLLER_PRUNED" "Removed retired controller ${others[index]}"
    else
      log_event "DEPLOY_CONTROLLER_PRUNE_SKIPPED" "Could not remove retired controller ${others[index]}"
    fi
  done
  # Staging directories and temporary switch entries outlive only a run that was killed; the lock
  # proves none of them is in use.
  while IFS= read -r -d '' path; do
    rm -rf -- "$path" ||
      log_event "DEPLOY_CONTROLLER_PRUNE_SKIPPED" "Could not remove ${path##*/}"
  done < <(
    find "$controller_root" -mindepth 1 -maxdepth 1 \( -name '.staging.*' -o -name '.current.tmp.*' \) -print0
    find "${launcher%/*}" -mindepth 1 -maxdepth 1 -name '.production-deploy.sh.tmp.*' -print0
  )
}
