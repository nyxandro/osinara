#!/bin/bash
# Copy of the sandboxes' folders taken while the current release still answers (#558, #577).
# Sourced after backup.sh: it reads BACKUPS_DIR, BACKUP_TEMP_DIR, BACKUP_DURABLE_VOLUMES and
# DEPLOY_BACKUP_NAME_PATTERN from there, and APP_IMAGE from release.sh.

# The sandboxes' folders are copied while the bot still answers, at the lowest CPU and disk priority
# (#558). The owner accepted that such a copy may hold a file a sandbox was writing half-written, and
# miss files made in the minutes before the stop; the database and the Google keys are still copied
# stopped. Compressing them whole took 14 minutes of the deploy at 6.5 GB (25.11.2026), so each copy is
# a folder that takes only changed files and hard-links the rest to the previous set (#577).
readonly LIVE_COPIED_VOLUMES=(
  "osinara-production-tool-environments"
  "osinara-production-workspace-data"
)
# Caches a sandbox downloads again on demand, left out of the copy (#577): `cache/` is the tools'
# XDG_CACHE_HOME, PIP_CACHE_DIR and PLAYWRIGHT_BROWSERS_PATH; `home/.cache/` holds puppeteer's Chrome.
declare -grA LIVE_COPY_EXCLUDES=(
  ["osinara-production-tool-environments"]="/*/cache/ /*/home/.cache/"
)
# rsync: "partial transfer due to vanished source files", what a live copy meets when the bot deletes
# a file between listing and copying it.
readonly RSYNC_VANISHED_SOURCE_FILES=24
# rsync: "partial transfer due to error" — also what a file the bot shortened while it was read gives.
readonly RSYNC_PARTIAL_TRANSFER=23

is_live_copied_volume() {
  local volume="$1" live
  for live in "${LIVE_COPIED_VOLUMES[@]}"; do
    [[ "$volume" == "$live" ]] && return 0
  done
  return 1
}

# The newest finished set that holds a folder copy of this volume. Sets made before #577 hold an
# archive instead, and the first copy after them takes every file.
latest_volume_copy() {
  local volume="$1" path name latest=""
  local nullglob_was_enabled=0
  shopt -q nullglob && nullglob_was_enabled=1
  shopt -s nullglob
  for path in "$BACKUPS_DIR"/*; do
    name="${path##*/}"
    [[ "$name" =~ $DEPLOY_BACKUP_NAME_PATTERN && -d "$path" && ! -L "$path" ]] || continue
    [[ -d "${path}/${volume}" && ! -L "${path}/${volume}" ]] || continue
    # Set names start with their UTC time, so the last match in glob order is the newest.
    latest="$name"
  done
  [[ "$nullglob_was_enabled" -eq 1 ]] || shopt -u nullglob
  printf '%s\n' "$latest"
}

# Copies one sandboxes' folder while the bot answers, at the lowest CPU and disk priority so it does not
# starve the bot on the slow disk. A file unchanged since the newest set becomes a hard link to it: the
# sets share those bytes, and rsync writes a changed file as a new one, so an earlier set never changes.
# Sockets and devices are left out, as tar left out sockets before.
copy_live_volume() {
  local volume="$1" previous pattern errors status=0
  local set_name="${BACKUP_TEMP_DIR##*/}"
  # The new set and the link source must sit under one mount: hard links never cross mounts.
  [[ "${BACKUP_TEMP_DIR%/*}" == "$BACKUPS_DIR" ]] ||
    fail "DEPLOY_BACKUP_TEMP_DIR_INVALID" "Backup set is not directly under ${BACKUPS_DIR}"
  local -a options=(--archive --hard-links --numeric-ids --no-devices --no-specials) excludes=()
  # `read -a` splits the patterns without expanding `/*/` against the host's own paths.
  if [[ -v LIVE_COPY_EXCLUDES["$volume"] ]]; then
    read -r -a excludes <<<"${LIVE_COPY_EXCLUDES["$volume"]}"
  fi
  for pattern in "${excludes[@]}"; do
    options+=("--exclude=${pattern}")
  done
  previous="$(latest_volume_copy "$volume")"
  [[ -z "$previous" ]] || options+=("--link-dest=/backups/${previous}/${volume}")
  errors="$(mktemp)"
  docker run --rm --network none --entrypoint /usr/bin/nice \
    --volume "${volume}:/data:ro" --volume "${BACKUPS_DIR}:/backups" "$APP_IMAGE" \
    -n 19 /usr/bin/ionice -c 3 /usr/bin/rsync "${options[@]}" /data/ "/backups/${set_name}/${volume}/" \
    2>"$errors" || status=$?
  # rsync's messages stay in the deploy journal; they are read here only to tell the cases apart.
  cat -- "$errors" >&2
  # The bot keeps working while this copy reads: a file it deleted or rewrote meanwhile is missing or
  # half-written in the copy (the accepted risk above). Every other failure — rsync's own and docker's
  # 125-127 — stops the deploy before the bot is stopped.
  if ((status == RSYNC_VANISHED_SOURCE_FILES)); then
    log_event "DEPLOY_LIVE_COPY_FILES_VANISHED" "Files of ${volume} vanished while copied live; the copy holds the rest"
  elif ((status == RSYNC_PARTIAL_TRANSFER)) && live_copy_errors_are_changes "$errors"; then
    log_event "DEPLOY_LIVE_COPY_FILES_CHANGED" "Files of ${volume} changed while copied live; the copy holds them as read"
  elif ((status != 0)); then
    rm -f -- "$errors"
    fail "DEPLOY_LIVE_COPY_FAILED" "Live copy of ${volume} failed with exit ${status}"
    return 1
  fi
  rm -f -- "$errors"
}

# True when rsync's error output names only files the bot changed or deleted during the copy. Exit 23
# also covers a file rsync could not open or write, which is no accepted risk: one such line fails it.
live_copy_errors_are_changes() {
  local errors="$1" line changed=0
  while IFS= read -r line; do
    case "$line" in
      *"read errors mapping "* | *"file has vanished: "*) changed=1 ;;
      # rsync's closing line for exit 23 itself.
      "rsync error: some files/attrs were not transferred "*) ;;
      *) return 1 ;;
    esac
  done <"$errors"
  ((changed == 1))
}

# Runs while the current release still serves: no admission drain, no stop.
copy_live_volumes() {
  local volume
  ((${#BACKUP_DURABLE_VOLUMES[@]} > 0)) ||
    fail "DEPLOY_BACKUP_VOLUME_SET_EMPTY" "Preflight did not select durable backup volumes"
  for volume in "${BACKUP_DURABLE_VOLUMES[@]}"; do
    is_live_copied_volume "$volume" || continue
    copy_live_volume "$volume"
  done
}
