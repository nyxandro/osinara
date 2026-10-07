#!/bin/bash
# Osinara production deployment orchestrator.
# Started by the launcher from one version directory of the controller tree; sources that
# directory's root-owned modules and coordinates one non-retryable release attempt.
set -Eeuo pipefail

readonly PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
CONTROLLER_DIR="$(dirname "$(readlink -f "$0")")"
readonly CONTROLLER_DIR
readonly BOOTSTRAP_CONTROLLER_ROOT="/opt/osinara/bin/controller"
readonly BOOTSTRAP_VERSION_PATTERN='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

bootstrap_require_metadata() {
  local path="$1"
  local expected="$2"
  local actual="missing"
  [[ -e "$path" && ! -L "$path" ]] && actual="$(stat -c '%u:%g:%a' "$path")"
  if [[ "$actual" != "$expected" ]]; then
    printf '%s\n' \
      "DEPLOY_PATH_PERMISSIONS_INVALID: ${path} has ${actual}; expected ${expected}" >&2
    exit 1
  fi
}

# Validate every sourced byte before root executes any deployment module.
[[ "$(id -u)" -eq 0 ]] || {
  printf '%s\n' "DEPLOY_ROOT_REQUIRED: production-deploy.sh must run as root" >&2
  exit 1
}
# Only a version directory of the root-owned controller tree may run as the controller.
if [[ "${CONTROLLER_DIR%/*}" != "$BOOTSTRAP_CONTROLLER_ROOT" ||
  ! "${CONTROLLER_DIR##*/}" =~ $BOOTSTRAP_VERSION_PATTERN ]]; then
  printf '%s\n' "DEPLOY_PATH_INVALID: the controller must run from ${BOOTSTRAP_CONTROLLER_ROOT}/vX.Y.Z" >&2
  exit 1
fi
bootstrap_require_metadata "/opt/osinara" "0:0:750"
bootstrap_require_metadata "/opt/osinara/bin" "0:0:750"
bootstrap_require_metadata "$BOOTSTRAP_CONTROLLER_ROOT" "0:0:750"
bootstrap_require_metadata "$CONTROLLER_DIR" "0:0:750"
for module in main common database release backup self-update; do
  bootstrap_require_metadata "${CONTROLLER_DIR}/${module}.sh" "0:0:640"
done
bootstrap_require_metadata "${CONTROLLER_DIR}/installation-compose.jq" "0:0:640"

# Modules expose explicit release, database, backup, self-update, and recovery boundaries.
# shellcheck source=scripts/production-deploy/common.sh
source "${CONTROLLER_DIR}/common.sh"
# shellcheck source=scripts/production-deploy/database.sh
source "${CONTROLLER_DIR}/database.sh"
# shellcheck source=scripts/production-deploy/release.sh
source "${CONTROLLER_DIR}/release.sh"
# shellcheck source=scripts/production-deploy/backup.sh
source "${CONTROLLER_DIR}/backup.sh"
# shellcheck source=scripts/production-deploy/self-update.sh
source "${CONTROLLER_DIR}/self-update.sh"

handle_failure() {
  local exit_code="$1"
  local line="$2"
  local reason="$3"
  # errtrace runs this trap inside command substitutions too. Only the main process records,
  # notifies, and recovers; a subshell exits and its failure reaches the parent's own trap.
  [[ "$BASHPID" == "$$" ]] || exit "$exit_code"
  [[ "$FAILURE_HANDLING" -eq 1 ]] && exit "$exit_code"
  FAILURE_HANDLING=1
  trap - ERR INT TERM
  set +e

  local status="failed"
  local code="DEPLOY_RELEASE_FAILED"
  local message="Deployment failed at line ${line}: ${reason} (exit ${exit_code})"
  if [[ "$MIGRATION_STARTED" -eq 1 ]]; then
    status="ambiguous"
    code="DEPLOY_RELEASE_AMBIGUOUS"
  elif [[ "$CURRENT_SERVICES_STOPPED" -eq 1 ]]; then
    if ! restart_current_release; then
      status="ambiguous"
      code="DEPLOY_CURRENT_RECOVERY_FAILED"
    fi
  fi

  # Candidate-only volumes are recoverable only while the current release is confirmed healthy.
  if [[ "$MIGRATION_STARTED" -eq 0 && "$CURRENT_SERVICES_STOPPED" -eq 0 ]]; then
    if ! cleanup_created_candidate_volumes; then
      status="ambiguous"
      code="DEPLOY_CANDIDATE_VOLUME_CLEANUP_FAILED"
      message="Deployment failed and an attempt-created candidate volume could not be removed"
    fi
  fi

  cleanup_incomplete_backup
  # Before migration, a deferred/failed update must return the old healthy runtime to service.
  if [[ "$MIGRATION_STARTED" -eq 0 && "$status" == "failed" ]]; then
    if ! resume_runtime_admission; then
      status="ambiguous"
      code="DEPLOY_ADMISSION_RECOVERY_FAILED"
      message="Could not restore request admission; operator recovery is required"
    fi
  fi
  log_event "$code" "$message"
  if [[ -n "$PROPOSAL_ID" && "$TERMINAL_RECORDED" -eq 0 ]]; then
    record_proposal_result "$status" "$code" "$message"
  fi
  if [[ "$status" == "failed" ]]; then
    send_telegram_notification \
      "Не удалось установить обновление v${REQUESTED_VERSION}. Текущая версия работает. Код: ${code}"
  else
    send_telegram_notification \
      "Не удалось однозначно завершить обновление v${REQUESTED_VERSION}. Нужна проверка сервера. Код: ${code}"
  fi
  exit "$exit_code"
}

handle_signal() {
  local signal="$1"
  local exit_code=143
  [[ "$signal" == "SIGINT" ]] && exit_code=130
  handle_failure "$exit_code" "$LINENO" "received ${signal}"
}

cleanup_runtime_files() {
  if [[ -n "$CONTROLLER_STAGING_DIR" && -d "$CONTROLLER_STAGING_DIR" ]]; then
    rm -rf -- "$CONTROLLER_STAGING_DIR"
  fi
  [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]] && rm -rf "$WORK_DIR"
}

# Work directories outlive only a run that was killed or that handed over to a newer controller
# (exec skips the exit trap). The lock is held here, so none of them belongs to a live run.
remove_stale_work_dirs() {
  find "$BASE_DIR" -mindepth 1 -maxdepth 1 -type d -name '.deploy.*' -exec rm -rf -- {} +
}

send_success_notification() {
  local message="Обновление Osinara v${REQUESTED_VERSION} успешно установлено. Код: DEPLOY_RELEASE_SUCCEEDED"
  if ! send_telegram_notification "$message"; then
    # Deployment is already terminally successful; Telegram ambiguity must not rewrite that fact.
    log_event "DEPLOY_SUCCESS_NOTIFICATION_FAILED" \
      "Release is healthy, but the success notification was not accepted by Telegram"
  fi
}

main() {
  if [[ "$#" -eq 2 && "$1" == "--initial" ]]; then
    INITIAL_MODE=1
    REQUESTED_VERSION="$2"
  elif [[ "$#" -eq 3 && "$1" == "--resume" ]]; then
    RESUMED_AFTER_SELF_UPDATE=1
  elif [[ "$#" -eq 1 && "$1" == "--preflight" ]]; then
    PREFLIGHT_MODE=1
  elif [[ "$#" -ne 0 ]]; then
    fail "DEPLOY_ARGUMENT_INVALID" \
      "Use production-deploy.sh or production-deploy.sh --initial VERSION"
  fi

  require_server_boundary
  require_deployment_profile
  require_release_environment_clean
  # A newer controller checks the host here before its predecessor selects it; nothing is claimed,
  # locked, or changed.
  if [[ "$PREFLIGHT_MODE" -eq 1 ]]; then
    set_current_release_paths
    log_event "DEPLOY_CONTROLLER_PREFLIGHT_PASSED" "This controller accepts the host"
    return 0
  fi
  if [[ "$RESUMED_AFTER_SELF_UPDATE" -eq 1 ]]; then
    require_inherited_deploy_lock "$LOCK_FILE"
  else
    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
      log_event "DEPLOY_ALREADY_RUNNING" "Another deployment process owns the lock"
      return 0
    fi
  fi
  remove_stale_work_dirs
  WORK_DIR="$(mktemp -d "${BASE_DIR}/.deploy.XXXXXX")"
  # Only the lock owner ends the window, so no exit can cut a running release short. Every timer
  # tick that finds nothing to do still passes here, which is how a window left behind by a
  # deployment killed before its trap ran gets cleared within a minute instead of running its full
  # length. A tick that finds the window already closed writes nothing: see `close_deploy_window`.
  trap 'close_deploy_window "$DEPLOY_WINDOW_METRIC"; cleanup_runtime_files' EXIT

  if [[ "$INITIAL_MODE" -eq 1 ]]; then
    require_semver "$REQUESTED_VERSION"
    require_clean_initial_state
  elif [[ "$RESUMED_AFTER_SELF_UPDATE" -eq 1 ]]; then
    set_current_release_paths
    adopt_claimed_proposal "$2" "$3"
    require_upgrade_from_current
  else
    set_current_release_paths
    reconcile_stale_deployments
    [[ "$STALE_DEPLOYMENT_FOUND" -eq 0 ]] || return 0
    claim_approved_proposal
    [[ "$CLAIM_FOUND" -eq 1 ]] || return 0
    require_upgrade_from_current
  fi

  # A deployment is certain from here on. Almost every timer tick returns above without an
  # approved proposal, and announcing the window there would suppress production alerts all day.
  open_deploy_window "$DEPLOY_WINDOW_METRIC"

  download_and_validate_release "$REQUESTED_VERSION"
  if [[ "$INITIAL_MODE" -eq 0 ]]; then
    recheck_claim_owner
    # Release rules below belong to the release: a different controller it carries replaces this
    # process here and continues the same claim from the top.
    ensure_release_controller "$CONTROLLER_ROOT" "$LAUNCHER_PATH"
  fi
  # The agent mounts the operator's active model config read-only; a looser file fails the release.
  require_metadata "$AGENT_MODEL_PROVIDER_CONFIG" "0:0:644"
  prepare_candidate_release
  pull_release_images
  if [[ "$INITIAL_MODE" -eq 0 ]]; then
    recheck_claim_owner
    preflight_backup
    prepare_runtime_update
    # Downtime starts on the next line and lasts through the backup. The window opened before the
    # download has been running through image pull, which has no bound of its own, so it is
    # refreshed here: an unusually slow pull must not leave the stop itself looking like an outage.
    open_deploy_window "$DEPLOY_WINDOW_METRIC"
    stop_current_services
    create_postgres_backup
    snapshot_durable_volumes
    prune_old_deploy_backups
  fi

  # Image pull and backup have already consumed part of the window; migration and the health
  # wait get a full one, so a long release never starts alerting on its own last minutes.
  open_deploy_window "$DEPLOY_WINDOW_METRIC"

  MIGRATION_STARTED=1
  start_candidate_release
  wait_for_health
  promote_candidate_release
  if [[ "$INITIAL_MODE" -eq 1 ]]; then
    resolve_initial_owner_chat
  fi
  resume_runtime_admission
  record_proposal_result "succeeded" "DEPLOY_RELEASE_SUCCEEDED" \
    "Release v${REQUESTED_VERSION} passed the production health check"
  send_success_notification
  prune_retired_release_images
  prune_retired_controllers "$CONTROLLER_ROOT" "$LAUNCHER_PATH"
  log_event "DEPLOY_RELEASE_SUCCEEDED" "Release v${REQUESTED_VERSION} is healthy"
}

trap 'handle_failure "$?" "$LINENO" "command failed"' ERR
trap 'handle_signal SIGTERM' TERM
trap 'handle_signal SIGINT' INT
main "$@"
