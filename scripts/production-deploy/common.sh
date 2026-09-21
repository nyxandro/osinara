#!/bin/bash
# Shared production deployment boundary and process utilities.
# Defines fixed paths, state flags, version comparison, Compose execution, and notifications.

readonly BASE_DIR="/opt/osinara"
readonly BIN_DIR="${BASE_DIR}/bin"
readonly SERVER_ENV="${BASE_DIR}/.env"
readonly AGENT_MODEL_PROVIDER_CONFIG="${BASE_DIR}/agent-model-providers.json"
readonly RELEASES_DIR="${BASE_DIR}/releases"
readonly BACKUPS_DIR="${BASE_DIR}/backups"
readonly GLOBAL_RELEASE_ENV="${BASE_DIR}/release.env"
readonly CURRENT_LINK="${BASE_DIR}/current"
readonly LOCK_FILE="/run/lock/osinara-production-deploy.lock"
readonly HEALTH_URL="http://127.0.0.1:8082/eve/v1/health"
readonly HEALTH_ATTEMPTS=60
readonly HEALTH_INTERVAL_SECONDS=5
# A release stops and restarts every production container, which the observability hub reads as
# an outage unless the release says otherwise. The monitoring collector ships *.prom files from
# this directory to the hub, and the osinara-production alert rules stand down while the published
# deadline is still ahead. A deadline rather than a flag: a deployment killed without running its
# exit trap has to restore alerting by itself instead of silencing production for good.
readonly DEPLOY_WINDOW_METRIC="/var/lib/monitoring-agent/textfile/osinara-deploy-window.prom"
# Observed releases need eleven to eighteen minutes from image pull to a healthy edge. The window
# is republished before migration, so this also bounds how long a killed deployment stays silent.
readonly DEPLOY_WINDOW_SECONDS=1800
readonly RELEASE_IMAGE_VARIABLES=(
  OSINARA_APP_IMAGE
  OSINARA_CLI_PROXY_IMAGE
  SANDBOX_RUNTIME_IMAGE
  OSINARA_SANDBOX_RUNNER_IMAGE
  OSINARA_SANDBOX_EGRESS_PROXY_IMAGE
  OSINARA_EDGE_IMAGE
)

INITIAL_MODE=0
CLAIM_FOUND=0
STALE_DEPLOYMENT_FOUND=0
REQUESTED_VERSION=""
PROPOSAL_ID=""
OWNER_CHAT_ID=""
LEASE_TOKEN=""
TERMINAL_RECORDED=0
MIGRATION_STARTED=0
DEPLOY_WINDOW_OPENED=0
CURRENT_SERVICES_STOPPED=0
FAILURE_HANDLING=0
WORK_DIR=""
CANDIDATE_DIR=""
CANDIDATE_COMPOSE=""
CANDIDATE_ENV=""
CURRENT_COMPOSE=""
CURRENT_ENV=""
BACKUP_TEMP_DIR=""

log_event() {
  local code="$1"
  local message="$2"
  jq -cn --arg code "$code" --arg message "$message" \
    '{code: $code, message: $message}' >&2
}

fail() {
  log_event "$1" "$2"
  return 1
}

require_metadata() {
  local path="$1"
  local expected="$2"
  local actual
  if [[ ! -e "$path" || -L "$path" ]]; then
    fail "DEPLOY_PATH_PERMISSIONS_INVALID" "Required path is absent or symbolic: ${path}"
  fi
  actual="$(stat -c '%u:%g:%a' "$path")"
  if [[ "$actual" != "$expected" ]]; then
    fail "DEPLOY_PATH_PERMISSIONS_INVALID" \
      "Required path ${path} has ${actual}; expected ${expected}"
  fi
}

require_server_boundary() {
  if [[ "$(id -u)" -ne 0 ]]; then
    fail "DEPLOY_ROOT_REQUIRED" "production-deploy.sh must run as root"
  fi
  if [[ "$ENTRYPOINT_PATH" != "${BIN_DIR}/production-deploy.sh" ]]; then
    fail "DEPLOY_PATH_INVALID" "Entrypoint must be ${BIN_DIR}/production-deploy.sh"
  fi
  require_metadata "$BASE_DIR" "0:0:750"
  require_metadata "$BIN_DIR" "0:0:750"
  require_metadata "$ENTRYPOINT_PATH" "0:0:750"
  require_metadata "$MODULE_DIR" "0:0:750"
  require_metadata "$SERVER_ENV" "0:0:600"
  install -d -o root -g root -m 0750 "$RELEASES_DIR" "$BACKUPS_DIR"

  local command
  for command in awk cmp curl df docker find flock install jq mktemp mv readlink \
    sha256sum sort stat tail tar; do
    command -v "$command" >/dev/null ||
      fail "DEPLOY_COMMAND_MISSING" "Required command is unavailable: ${command}"
  done
}

require_release_environment_clean() {
  local name
  for name in "${RELEASE_IMAGE_VARIABLES[@]}"; do
    if [[ -v "$name" ]]; then
      fail "DEPLOY_RELEASE_ENV_EXPORTED" \
        "Release image variable ${name} must not be exported by the server EnvironmentFile"
    fi
  done
}

require_semver() {
  local version="$1"
  [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
    fail "DEPLOY_VERSION_INVALID" "Release version must be stable SemVer X.Y.Z"
}

version_is_greater() {
  local candidate="$1"
  local current="$2"
  local candidate_major candidate_minor candidate_patch
  local current_major current_minor current_patch
  require_semver "$candidate"
  require_semver "$current"
  IFS=. read -r candidate_major candidate_minor candidate_patch <<<"$candidate"
  IFS=. read -r current_major current_minor current_patch <<<"$current"
  local index
  local -a candidate_parts=("$candidate_major" "$candidate_minor" "$candidate_patch")
  local -a current_parts=("$current_major" "$current_minor" "$current_patch")
  for index in 0 1 2; do
    ((10#${candidate_parts[index]} > 10#${current_parts[index]})) && return 0
    ((10#${candidate_parts[index]} < 10#${current_parts[index]})) && return 1
  done
  return 1
}

compose_current() {
  docker compose --project-name osinara-production --env-file "$SERVER_ENV" \
    --env-file "$CURRENT_ENV" --file "$CURRENT_COMPOSE" "$@"
}

compose_candidate() {
  docker compose --project-name osinara-production --env-file "$SERVER_ENV" \
    --env-file "$CANDIDATE_ENV" --file "$CANDIDATE_COMPOSE" "$@"
}

set_current_release_paths() {
  if [[ ! -L "$CURRENT_LINK" || ! -f "$GLOBAL_RELEASE_ENV" ]]; then
    fail "DEPLOY_INITIAL_REQUIRED" "Run the first deployment with --initial VERSION"
  fi
  CURRENT_COMPOSE="${CURRENT_LINK}/compose.production.yaml"
  CURRENT_ENV="${CURRENT_LINK}/release.env"
  [[ -f "$CURRENT_COMPOSE" && -f "$CURRENT_ENV" ]] ||
    fail "DEPLOY_CURRENT_RELEASE_INVALID" "Current release files are incomplete"
}

require_clean_initial_state() {
  local containers
  if [[ -e "$CURRENT_LINK" || -e "$GLOBAL_RELEASE_ENV" ]]; then
    fail "DEPLOY_INITIAL_STATE_EXISTS" "Current release state already exists"
  fi
  containers="$(docker ps -a --filter \
    label=com.docker.compose.project=osinara-production --format '{{.ID}}')"
  [[ -z "$containers" ]] ||
    fail "DEPLOY_INITIAL_STATE_EXISTS" "osinara-production containers already exist"
}

wait_for_health() {
  local attempt
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1)); do
    if curl --fail --silent --show-error --max-time 5 --output /dev/null "$HEALTH_URL"; then
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
  done
  fail "DEPLOY_HEALTH_TIMEOUT" "Released edge did not become healthy within the bounded wait"
}

# Announces that release noise on osinara-production is expected until the published deadline.
# Called again before migration so the slow phases each get a full window of their own.
open_deploy_window() {
  DEPLOY_WINDOW_OPENED=1
  publish_deploy_window "$1" "$(($(date +%s) + DEPLOY_WINDOW_SECONDS))"
}

# Ends the window now, so a release that failed stops being suppressed at once: a half-installed
# release is exactly what has to become visible.
#
# Writes only when there is a window to end. The trap that calls this is armed before the early
# returns, so it also runs on the ordinary timer tick that finds no release to make — about once a
# minute, forever. Stamping the mark with the current time on those ticks is what silenced
# `OsinaraIngressStuck`: that rule allows ten minutes of grace on top of the mark for the queue to
# drain after a release, and a mark refreshed every minute never falls that far behind. The alert
# that exists for "the assistant stopped answering people" stood down around the clock.
close_deploy_window() {
  [[ -f "$1" ]] || return 0
  if [[ "$DEPLOY_WINDOW_OPENED" -eq 0 ]] && ! deploy_window_needs_closing "$1"; then
    return 0
  fi
  publish_deploy_window "$1" "$(date +%s)"
}

# True while the published sample still stands for something this tick has to end: a deadline
# ahead of now, which is what a release killed between opening its window and reaching its trap
# leaves behind, or a sample nothing can parse, which the collector cannot read either and which
# one valid write repairs for good. A deadline already behind us is the ordinary resting state and
# must be left exactly as it is.
deploy_window_needs_closing() {
  local published
  published="$(awk '/^deploy_window_end_timestamp_seconds\{/ { value = $NF } END { print value }' \
    "$1" 2>/dev/null)" || return 0
  # `10#` keeps a hand-edited leading zero from being read as octal and printing a shell error.
  [[ "$published" =~ ^[0-9]+$ ]] || return 0
  if (( 10#$published > $(date +%s) )); then
    return 0
  fi
  return 1
}

# Monitoring is optional infrastructure that the application does not depend on. Storage that is
# absent or unwritable is recorded and the release continues: aborting an owner-approved
# deployment over a suppression hint would trade a cosmetic problem for a real one.
publish_deploy_window() {
  local metric_file="$1"
  local deadline="$2"
  local directory temporary
  directory="$(dirname "$metric_file")"
  # Only presence is worth asking about: the deployment runs as root, for whom a writability test
  # on a directory is always true. Whether the write can actually happen is answered below, by
  # attempting it.
  if [[ ! -d "$directory" ]]; then
    log_event "DEPLOY_WINDOW_METRIC_UNAVAILABLE" \
      "Collector directory ${directory} is absent; release alerts stay active"
    return 0
  fi
  if ! temporary="$(mktemp "${metric_file}.XXXXXX" 2>/dev/null)"; then
    log_event "DEPLOY_WINDOW_METRIC_UNAVAILABLE" \
      "Could not create a sample next to ${metric_file}; release alerts stay active"
    return 0
  fi
  # A sample the collector reads half-written is a parse error, and a parse error costs at least
  # this file's metrics and may cost the whole directory's, so what the collector can see is only
  # ever replaced whole.
  if render_deploy_window_sample "$deadline" >"$temporary" &&
    chmod 0644 "$temporary" &&
    mv -f "$temporary" "$metric_file"; then
    return 0
  fi
  # `|| true` is not decoration: the script runs under an ERR trap, and a read-only filesystem
  # fails the removal as readily as it failed the move. A bare failure here would abort an
  # owner-approved release over a suppression hint, which is the one thing this must never do.
  rm -f "$temporary" || true
  log_event "DEPLOY_WINDOW_METRIC_UNAVAILABLE" \
    "Could not publish ${metric_file}; release alerts stay active"
  return 0
}

render_deploy_window_sample() {
  local deadline="$1"
  printf '# HELP deploy_window_end_timestamp_seconds %s\n' \
    'Unix time until which release noise is expected for this project.'
  printf '# TYPE deploy_window_end_timestamp_seconds gauge\n'
  printf 'deploy_window_end_timestamp_seconds{project="osinara-production"} %s\n' \
    "$deadline"
}

send_telegram_notification() {
  local text="$1"
  [[ -z "$OWNER_CHAT_ID" ]] && return 0
  if [[ ! "${TELEGRAM_BOT_TOKEN:-}" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then
    fail "DEPLOY_TELEGRAM_TOKEN_INVALID" "Telegram token from EnvironmentFile is absent or invalid"
    return 1
  fi
  local curl_config
  curl_config="$(mktemp "${WORK_DIR}/telegram-curl.XXXXXX")"
  chmod 0600 "$curl_config"
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' \
    "$TELEGRAM_BOT_TOKEN" > "$curl_config"
  curl --fail --silent --show-error --max-time 30 --output /dev/null \
    --config "$curl_config" --request POST \
    --data-urlencode "chat_id=${OWNER_CHAT_ID}" --data-urlencode "text=${text}"
  rm -f "$curl_config"
}
