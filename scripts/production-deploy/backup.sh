#!/bin/bash
# Pre-migration backup and current-release recovery operations.
# Dumps PostgreSQL while live, then snapshots only irreconstructible volumes while writers are stopped.

readonly BACKUP_RESERVE_BYTES=$((512 * 1024 * 1024))
readonly RETAINED_DEPLOY_BACKUP_COUNT=1
readonly LEGACY_INITIAL_MIGRATION_BACKUP_NAME="initial-migration-v0.1.1"
readonly DEPLOY_BACKUP_NAME_PATTERN='^[0-9]{8}T[0-9]{6}Z-to-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
readonly LEGACY_EVE_VOLUME="osinara-production-workflow-data"
readonly LEGACY_EVE_LOGICAL_VOLUME="workflow-data"
readonly CURRENT_EVE_LOGICAL_VOLUME="eve-workflow-data"
readonly POSTGRES_WORLD_CUTOVER_VOLUME="osinara-production-eve-workflow-data-v032"
readonly DURABLE_VOLUME_BINDINGS=(
  "osinara-production-cli-proxy-auth|cli-proxy-auth"
  "osinara-production-google-workspace-credentials|google-workspace-credentials"
  "osinara-production-tool-environments|tool-environments"
  "osinara-production-workflow-data|workflow-data"
  "osinara-production-eve-workflow-data-v032|eve-workflow-data"
  "osinara-production-workspace-data|workspace-data"
)
BACKUP_DURABLE_VOLUMES=()
CREATED_CANDIDATE_VOLUMES=()
RETIRED_CUTOVER_VOLUME=""
RETIRED_CUTOVER_ARCHIVED=0
PRESERVED_WORKFLOW_CUTOVER_VOLUME=""
CANDIDATE_HEALTH_VALIDATED=0
COMPLETED_BACKUP_DIR=""

prune_old_deploy_backups() {
  if [[ -z "$COMPLETED_BACKUP_DIR" || ! -d "$COMPLETED_BACKUP_DIR" || -L "$COMPLETED_BACKUP_DIR" ||
        "$COMPLETED_BACKUP_DIR" != "$BACKUPS_DIR/${COMPLETED_BACKUP_DIR##*/}" ||
        ! "${COMPLETED_BACKUP_DIR##*/}" =~ $DEPLOY_BACKUP_NAME_PATTERN ]]; then
    fail "DEPLOY_BACKUP_NOT_READY" "A complete new backup is required before removing any old copy"
    return 1
  fi
  if ! (cd -- "$COMPLETED_BACKUP_DIR" && sha256sum --check --status SHA256SUMS); then
    fail "DEPLOY_BACKUP_VERIFICATION_FAILED" "New backup checksum verification failed; old copies were retained"
    return 1
  fi
  local -a deploy_backups=()
  local nullglob_was_enabled=0 path name remove_count index
  shopt -q nullglob && nullglob_was_enabled=1
  shopt -s nullglob

  # Timestamped deployment backups sort lexicographically; the bootstrap snapshot is pruned below.
  for path in "$BACKUPS_DIR"/*; do
    [[ -d "$path" ]] || continue
    [[ "$path" == "$COMPLETED_BACKUP_DIR" ]] && continue
    name="${path##*/}"
    [[ "$name" =~ $DEPLOY_BACKUP_NAME_PATTERN ]] && deploy_backups+=("$path")
  done
  [[ "$nullglob_was_enabled" -eq 1 ]] || shopt -u nullglob

  # Keep the explicit verified copy even if the host clock moved backwards since an older backup.
  remove_count=$((${#deploy_backups[@]} - RETAINED_DEPLOY_BACKUP_COUNT + 1))
  for ((index = 0; index < remove_count; index += 1)); do
    name="${deploy_backups[index]##*/}"
    rm -rf -- "${deploy_backups[index]}" ||
      fail "DEPLOY_BACKUP_RETENTION_FAILED" "Could not remove old deploy backup: ${name}"
    log_event "DEPLOY_BACKUP_PRUNED" "Removed old deploy backup: ${name}"
  done

  # The rolling pre-deploy snapshot supersedes the historical bootstrap copy.
  path="${BACKUPS_DIR}/${LEGACY_INITIAL_MIGRATION_BACKUP_NAME}"
  if [[ -d "$path" ]]; then
    rm -rf -- "$path" ||
      fail "DEPLOY_BACKUP_RETENTION_FAILED" "Could not remove legacy initial migration backup"
    log_event "DEPLOY_BACKUP_PRUNED" "Removed legacy initial migration backup"
  fi
}

compose_declares_volume() {
  local compose_path="$1"
  local logical_volume="$2"
  if [[ ! "$logical_volume" =~ ^[a-z0-9-]+$ ]]; then
    fail "DEPLOY_VOLUME_NAME_INVALID" "Logical durable volume name is invalid"
    return 1
  fi
  if [[ ! -f "$compose_path" ]]; then
    fail "DEPLOY_COMPOSE_OWNERSHIP_UNKNOWN" "Compose file is absent: ${compose_path}"
    return 1
  fi
  grep -Eq "^  ${logical_volume}:([[:space:]]*\\{\\})?[[:space:]]*$" "$compose_path"
}

ensure_durable_volume() {
  local volume="$1"
  local logical_volume="$2"
  local current_owns=0 candidate_owns=0
  compose_declares_volume "$CURRENT_COMPOSE" "$logical_volume" && current_owns=1
  compose_declares_volume "$CANDIDATE_COMPOSE" "$logical_volume" && candidate_owns=1

  # Existing bytes are trusted only after the current immutable release has owned the volume.
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    [[ "$current_owns" -eq 1 ]] && return 0
    [[ "$candidate_owns" -eq 1 ]] &&
      fail "DEPLOY_CANDIDATE_VOLUME_OWNERSHIP_AMBIGUOUS" \
        "Candidate durable volume already exists without current release ownership: ${volume}"
    fail "DEPLOY_VOLUME_OWNERSHIP_INVALID" "Durable volume has no Compose owner: ${volume}"
  fi

  # Missing current-owned bytes signal data loss. Only an absent, newly declared candidate is created.
  [[ "$current_owns" -eq 0 ]] ||
    fail "DEPLOY_BACKUP_VOLUME_MISSING" "Required durable volume is absent: ${volume}"
  if [[ "$candidate_owns" -eq 1 ]]; then
    if ! docker volume create "$volume" >/dev/null; then
      fail "DEPLOY_CANDIDATE_VOLUME_CREATE_FAILED" \
        "Could not create candidate durable volume: ${volume}"
      return 1
    fi
    CREATED_CANDIDATE_VOLUMES+=("$volume")
    return 0
  fi
  fail "DEPLOY_VOLUME_OWNERSHIP_INVALID" "Durable volume has no Compose owner: ${volume}"
}

cleanup_created_candidate_volumes() {
  [[ "$MIGRATION_STARTED" -eq 0 ]] || return 0
  local volume
  for volume in "${CREATED_CANDIDATE_VOLUMES[@]}"; do
    # Only names recorded after this attempt's successful `docker volume create` are eligible.
    if ! docker volume rm "$volume" >/dev/null; then
      fail "DEPLOY_CANDIDATE_VOLUME_CLEANUP_FAILED" \
        "Could not remove attempt-created candidate volume: ${volume}"
      return 1
    fi
    log_event "DEPLOY_CANDIDATE_VOLUME_CLEANED" \
      "Removed attempt-created candidate volume: ${volume}"
  done
  CREATED_CANDIDATE_VOLUMES=()
}

select_durable_volumes() {
  local binding volume logical_volume current_owns candidate_owns
  BACKUP_DURABLE_VOLUMES=()
  RETIRED_CUTOVER_VOLUME=""
  RETIRED_CUTOVER_ARCHIVED=0
  PRESERVED_WORKFLOW_CUTOVER_VOLUME=""
  for binding in "${DURABLE_VOLUME_BINDINGS[@]}"; do
    IFS='|' read -r volume logical_volume <<<"$binding"
    current_owns=0
    candidate_owns=0
    compose_declares_volume "$CURRENT_COMPOSE" "$logical_volume" && current_owns=1
    compose_declares_volume "$CANDIDATE_COMPOSE" "$logical_volume" && candidate_owns=1
    [[ "$current_owns" -eq 1 || "$candidate_owns" -eq 1 ]] || continue

    # Each documented world cutover must preserve a restorable snapshot before changing ownership.
    if [[ "$current_owns" -eq 1 && "$candidate_owns" -eq 0 ]]; then
      if [[ "$volume" == "$LEGACY_EVE_VOLUME" &&
            "$logical_volume" == "$LEGACY_EVE_LOGICAL_VOLUME" ]] &&
        compose_declares_volume "$CANDIDATE_COMPOSE" "$CURRENT_EVE_LOGICAL_VOLUME"; then
        RETIRED_CUTOVER_VOLUME="$volume"
      elif [[ "$volume" == "$POSTGRES_WORLD_CUTOVER_VOLUME" &&
              "$logical_volume" == "$CURRENT_EVE_LOGICAL_VOLUME" ]]; then
        # PostgreSQL cutover keeps the physical v0.32 volume for immediate rollback.
        PRESERVED_WORKFLOW_CUTOVER_VOLUME="$volume"
      else
        fail "DEPLOY_CANDIDATE_DURABLE_VOLUME_REMOVED" \
          "Candidate release removes a current-owned durable volume: ${volume}"
        return 1
      fi
    fi

    # Current ownership selects backup input; candidate-only ownership permits one clean bootstrap.
    ensure_durable_volume "$volume" "$logical_volume"
    [[ "$current_owns" -eq 0 ]] || BACKUP_DURABLE_VOLUMES+=("$volume")
  done
  ((${#BACKUP_DURABLE_VOLUMES[@]} > 0)) ||
    fail "DEPLOY_BACKUP_VOLUME_SET_EMPTY" "Current release owns no durable backup volumes"
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
  select_durable_volumes
  for volume in "${BACKUP_DURABLE_VOLUMES[@]}"; do
    volume_bytes="$(volume_size_bytes "$volume")"
    required_bytes=$((required_bytes + volume_bytes))
  done
  local database_bytes
  database_bytes="$(psql_current --command="SELECT pg_database_size('osinara');")"
  [[ "$database_bytes" =~ ^[0-9]+$ ]] ||
    fail "DEPLOY_BACKUP_SIZE_INVALID" "Could not determine PostgreSQL size"
  local workflow_database_exists workflow_database_bytes=0
  workflow_database_exists="$(psql_current --command="SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'osinara_workflow');")"
  [[ "$workflow_database_exists" == "t" || "$workflow_database_exists" == "f" ]] ||
    fail "DEPLOY_BACKUP_DATABASE_STATE_INVALID" "Could not determine Workflow database state"
  if [[ "$workflow_database_exists" == "t" ]]; then
    workflow_database_bytes="$(psql_current --command="SELECT pg_database_size('osinara_workflow');")"
    [[ "$workflow_database_bytes" =~ ^[0-9]+$ ]] ||
      fail "DEPLOY_BACKUP_SIZE_INVALID" "Could not determine Workflow PostgreSQL size"
  fi
  required_bytes=$(((required_bytes + database_bytes + workflow_database_bytes) * 2 + BACKUP_RESERVE_BYTES))

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
  local workflow_database_exists
  workflow_database_exists="$(psql_current --command="SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'osinara_workflow');")"
  if [[ "$workflow_database_exists" == "t" ]]; then
    compose_current exec -T postgres pg_dump --username osinara --dbname osinara_workflow \
      --format=custom --no-owner --no-privileges > "${BACKUP_TEMP_DIR}/workflow-postgres.dump"
    compose_current exec -T postgres pg_restore --list < "${BACKUP_TEMP_DIR}/workflow-postgres.dump" \
      > /dev/null
  elif [[ "$workflow_database_exists" != "f" ]]; then
    fail "DEPLOY_BACKUP_DATABASE_STATE_INVALID" "Could not determine Workflow database state"
  fi
}

stop_current_services() {
  CURRENT_SERVICES_STOPPED=1
  compose_current stop memory-extraction-worker edge telegram-ingress-worker memory-embedding-worker agent cli-proxy-api \
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
  ((${#BACKUP_DURABLE_VOLUMES[@]} > 0)) ||
    fail "DEPLOY_BACKUP_VOLUME_SET_EMPTY" "Preflight did not select durable backup volumes"
  for volume in "${BACKUP_DURABLE_VOLUMES[@]}"; do
    backup_volume "$volume"
    if [[ -n "$RETIRED_CUTOVER_VOLUME" && "$volume" == "$RETIRED_CUTOVER_VOLUME" ]]; then
      RETIRED_CUTOVER_ARCHIVED=1
    fi
  done
  # Relative paths remain verifiable after the temporary directory is atomically renamed.
  (cd -- "$BACKUP_TEMP_DIR" && sha256sum -- ./* > SHA256SUMS && sha256sum --check --status SHA256SUMS)
  local timestamp final_dir
  timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
  final_dir="${BACKUPS_DIR}/${timestamp}-to-v${REQUESTED_VERSION}"
  [[ ! -e "$final_dir" ]] ||
    fail "DEPLOY_BACKUP_DIR_EXISTS" "Final backup directory already exists"
  mv "$BACKUP_TEMP_DIR" "$final_dir"
  BACKUP_TEMP_DIR=""
  COMPLETED_BACKUP_DIR="$final_dir"
}

remove_retired_cutover_volume() {
  [[ -n "$RETIRED_CUTOVER_VOLUME" ]] || return 0
  if [[ "$RETIRED_CUTOVER_VOLUME" != "$LEGACY_EVE_VOLUME" ||
        "$RETIRED_CUTOVER_ARCHIVED" -ne 1 || "$CANDIDATE_HEALTH_VALIDATED" -ne 1 ]]; then
    fail "DEPLOY_RETIRED_VOLUME_BOUNDARY_INVALID" \
      "Legacy Eve volume retirement requires its validated archive and a healthy candidate"
    return 1
  fi

  # This exact one-time cutover volume is retired only at the post-health success boundary.
  if ! docker volume rm "$RETIRED_CUTOVER_VOLUME" >/dev/null; then
    fail "DEPLOY_RETIRED_VOLUME_REMOVAL_FAILED" \
      "Could not remove the archived legacy Eve volume: ${RETIRED_CUTOVER_VOLUME}"
    return 1
  fi
  log_event "DEPLOY_RETIRED_VOLUME_REMOVED" \
    "Removed archived legacy Eve volume: ${RETIRED_CUTOVER_VOLUME}"
  RETIRED_CUTOVER_VOLUME=""
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
