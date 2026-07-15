#!/bin/bash
# Pre-migration backup and current-release recovery operations.
# Dumps PostgreSQL while live, then snapshots only irreconstructible volumes while writers are stopped.

readonly BACKUP_RESERVE_BYTES=$((512 * 1024 * 1024))
readonly DURABLE_VOLUMES=(
  osinara-production-google-workspace-credentials
  osinara-production-tool-environments
  osinara-production-workflow-data
  osinara-production-workspace-data
)

ensure_durable_volume() {
  local volume="$1"
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    return 0
  fi

  # The Google profile store is introduced after v0.2.10. Create it only when the current
  # release never referenced it; once a release owns it, absence is a data-loss signal.
  [[ -f "$CURRENT_COMPOSE" ]] ||
    fail "DEPLOY_CURRENT_COMPOSE_MISSING" "Current release Compose file is absent"
  local current_compose_text
  current_compose_text="$(<"$CURRENT_COMPOSE")"
  if [[ "$volume" == "osinara-production-google-workspace-credentials" &&
        "$current_compose_text" != *"google-workspace-credentials"* ]]; then
    docker volume create "$volume" >/dev/null
    return 0
  fi

  fail "DEPLOY_BACKUP_VOLUME_MISSING" "Required durable volume is absent: ${volume}"
}

volume_size_bytes() {
  local volume="$1"
  local output size
  output="$(docker run --rm --network none --entrypoint /usr/bin/du \
    --volume "${volume}:/data:ro" "$APP_IMAGE" -sb /data)"
  read -r size _ <<<"$output"
  [[ "$size" =~ ^[0-9]+$ ]] ||
    fail "DEPLOY_BACKUP_SIZE_INVALID" "Could not determine size for ${volume}"
  printf '%s\n' "$size"
}

preflight_backup() {
  local volume volume_bytes
  local required_bytes=0
  for volume in "${DURABLE_VOLUMES[@]}"; do
    ensure_durable_volume "$volume"
    volume_bytes="$(volume_size_bytes "$volume")"
    required_bytes=$((required_bytes + volume_bytes))
  done
  local database_bytes
  database_bytes="$(psql_current --command="SELECT pg_database_size('osinara');")"
  [[ "$database_bytes" =~ ^[0-9]+$ ]] ||
    fail "DEPLOY_BACKUP_SIZE_INVALID" "Could not determine PostgreSQL size"
  required_bytes=$(((required_bytes + database_bytes) * 2 + BACKUP_RESERVE_BYTES))

  local -a disk_lines
  mapfile -t disk_lines < <(df --output=avail -B1 "$BACKUPS_DIR")
  local available_bytes="${disk_lines[${#disk_lines[@]} - 1]//[[:space:]]/}"
  [[ "$available_bytes" =~ ^[0-9]+$ ]] ||
    fail "DEPLOY_BACKUP_SPACE_INVALID" "Could not determine backup filesystem capacity"
  ((available_bytes >= required_bytes)) ||
    fail "DEPLOY_BACKUP_SPACE_INSUFFICIENT" "Backup filesystem has insufficient free space"
}

create_postgres_backup() {
  BACKUP_TEMP_DIR="$(mktemp -d "${BACKUPS_DIR}/.backup.XXXXXX")"
  compose_current exec -T postgres pg_dump --username osinara --dbname osinara \
    --format=custom --no-owner --no-privileges > "${BACKUP_TEMP_DIR}/postgres.dump"
  compose_current exec -T postgres pg_restore --list < "${BACKUP_TEMP_DIR}/postgres.dump" \
    > /dev/null
}

stop_current_services() {
  CURRENT_SERVICES_STOPPED=1
  compose_current stop edge telegram-ingress-worker memory-embedding-worker agent \
    sandbox-runner sandbox-egress-proxy memory-embedding
}

backup_volume() {
  local volume="$1"
  local archive="${BACKUP_TEMP_DIR}/${volume}.tar.gz"
  docker run --rm --network none --entrypoint /bin/tar \
    --volume "${volume}:/data:ro" --volume "${BACKUP_TEMP_DIR}:/backup" "$APP_IMAGE" \
    -czf "/backup/${volume}.tar.gz" -C /data .
  tar -tzf "$archive" >/dev/null
}

snapshot_durable_volumes() {
  local volume
  for volume in "${DURABLE_VOLUMES[@]}"; do
    backup_volume "$volume"
  done
  sha256sum "${BACKUP_TEMP_DIR}"/* > "${BACKUP_TEMP_DIR}/SHA256SUMS"
  local timestamp final_dir
  timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
  final_dir="${BACKUPS_DIR}/${timestamp}-to-v${REQUESTED_VERSION}"
  [[ ! -e "$final_dir" ]] ||
    fail "DEPLOY_BACKUP_DIR_EXISTS" "Final backup directory already exists"
  mv "$BACKUP_TEMP_DIR" "$final_dir"
  BACKUP_TEMP_DIR=""
}

cleanup_incomplete_backup() {
  if [[ -n "$BACKUP_TEMP_DIR" && -d "$BACKUP_TEMP_DIR" ]]; then
    rm -rf "$BACKUP_TEMP_DIR"
    BACKUP_TEMP_DIR=""
  fi
}

restart_current_release() {
  [[ -n "$CURRENT_COMPOSE" && -n "$CURRENT_ENV" ]] || return 1
  compose_current up --detach --remove-orphans --no-build --wait --wait-timeout 600 || return 1
  wait_for_health || return 1
  CURRENT_SERVICES_STOPPED=0
  return 0
}
