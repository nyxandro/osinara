#!/bin/bash
# Shared production deployment boundary and process utilities.
# Defines fixed paths, state flags, version comparison, Compose execution, and notifications.

readonly BASE_DIR="/opt/osinara"
readonly BIN_DIR="${BASE_DIR}/bin"
readonly SERVER_ENV="${BASE_DIR}/.env"
readonly MODEL_PROVIDER_CONFIG="${BASE_DIR}/model-providers.json"
readonly RELEASES_DIR="${BASE_DIR}/releases"
readonly BACKUPS_DIR="${BASE_DIR}/backups"
readonly GLOBAL_RELEASE_ENV="${BASE_DIR}/release.env"
readonly CURRENT_LINK="${BASE_DIR}/current"
readonly LOCK_FILE="/run/lock/osinara-production-deploy.lock"
readonly HEALTH_URL="http://127.0.0.1:8082/eve/v1/health"
readonly HEALTH_ATTEMPTS=60
readonly HEALTH_INTERVAL_SECONDS=5
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
  require_metadata "$MODEL_PROVIDER_CONFIG" "0:0:644"
  install -d -o root -g root -m 0750 "$RELEASES_DIR" "$BACKUPS_DIR"

  local command
  for command in cmp curl df docker find flock install jq mktemp readlink \
    sha256sum sort stat tar; do
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
