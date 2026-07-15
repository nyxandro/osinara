#!/bin/bash
# Osinara production deployment orchestrator.
# Sources fixed root-owned modules and coordinates one non-retryable release attempt.
set -Eeuo pipefail

readonly PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ENTRYPOINT_PATH="$(readlink -f "$0")"
MODULE_DIR="$(dirname "$ENTRYPOINT_PATH")/production-deploy"
readonly ENTRYPOINT_PATH MODULE_DIR

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
[[ "$ENTRYPOINT_PATH" == "/opt/osinara/bin/production-deploy.sh" ]] || {
  printf '%s\n' "DEPLOY_PATH_INVALID: production deploy entrypoint path is invalid" >&2
  exit 1
}
bootstrap_require_metadata "/opt/osinara" "0:0:750"
bootstrap_require_metadata "/opt/osinara/bin" "0:0:750"
bootstrap_require_metadata "$ENTRYPOINT_PATH" "0:0:750"
bootstrap_require_metadata "$MODULE_DIR" "0:0:750"
for module in common database release backup; do
  bootstrap_require_metadata "${MODULE_DIR}/${module}.sh" "0:0:640"
done

# Modules expose explicit release, database, backup, and recovery boundaries.
# shellcheck source=scripts/production-deploy/common.sh
source "${MODULE_DIR}/common.sh"
# shellcheck source=scripts/production-deploy/database.sh
source "${MODULE_DIR}/database.sh"
# shellcheck source=scripts/production-deploy/release.sh
source "${MODULE_DIR}/release.sh"
# shellcheck source=scripts/production-deploy/backup.sh
source "${MODULE_DIR}/backup.sh"

handle_failure() {
  local exit_code="$1"
  local line="$2"
  local reason="$3"
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

  cleanup_incomplete_backup
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
  [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]] && rm -rf "$WORK_DIR"
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
  elif [[ "$#" -ne 0 ]]; then
    fail "DEPLOY_ARGUMENT_INVALID" \
      "Use production-deploy.sh or production-deploy.sh --initial VERSION"
  fi

  require_server_boundary
  require_release_environment_clean
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log_event "DEPLOY_ALREADY_RUNNING" "Another deployment process owns the lock"
    return 0
  fi
  WORK_DIR="$(mktemp -d "${BASE_DIR}/.deploy.XXXXXX")"
  trap cleanup_runtime_files EXIT

  if [[ "$INITIAL_MODE" -eq 1 ]]; then
    require_semver "$REQUESTED_VERSION"
    require_clean_initial_state
  else
    set_current_release_paths
    reconcile_stale_deployments
    [[ "$STALE_DEPLOYMENT_FOUND" -eq 0 ]] || return 0
    claim_approved_proposal
    [[ "$CLAIM_FOUND" -eq 1 ]] || return 0
    require_upgrade_from_current
    prune_old_deploy_backups
  fi

  download_and_validate_release "$REQUESTED_VERSION"
  prepare_candidate_release
  pull_release_images
  if [[ "$INITIAL_MODE" -eq 0 ]]; then
    recheck_claim_owner
    preflight_backup
    create_postgres_backup
    stop_current_services
    snapshot_durable_volumes
  fi

  MIGRATION_STARTED=1
  start_candidate_release
  wait_for_health
  promote_candidate_release
  if [[ "$INITIAL_MODE" -eq 1 ]]; then
    resolve_initial_owner_chat
  fi
  record_proposal_result "succeeded" "DEPLOY_RELEASE_SUCCEEDED" \
    "Release v${REQUESTED_VERSION} passed the production health check"
  send_success_notification
  prune_retired_release_images
  log_event "DEPLOY_RELEASE_SUCCEEDED" "Release v${REQUESTED_VERSION} is healthy"
}

trap 'handle_failure "$?" "$LINENO" "command failed"' ERR
trap 'handle_signal SIGTERM' TERM
trap 'handle_signal SIGINT' INT
main "$@"
