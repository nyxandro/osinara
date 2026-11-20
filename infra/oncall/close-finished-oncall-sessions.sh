#!/bin/bash
# Closes the Orca terminals of on-call runs that finished their work (#428).
#
# Orca's automation starts the on-call agent as `claude '<prompt>'` in a terminal of its own. After its
# report Claude Code waits for input and never exits, so every hourly run while an alert burned left about
# 0.4 GB behind on the host the bot and its database share. Cron runs this every ten minutes as the user who
# owns the sessions. A session's terminal is closed only when all of these hold:
# - its process is alive, started with the on-call prompt, and is the very process its session file names
#   (same start time, so a reused process number never qualifies);
# - its history holds exactly one message from a person, the prompt itself: a session someone went on
#   working in by hand is never touched;
# - its history has not changed for IDLE_MINUTES.
#
# Usage: close-finished-oncall-sessions.sh [claude-home]   (default: ~/.claude)
# Install: a copy in ~/.local/bin, and in `crontab -e`:
#   PATH=/home/vps/.local/bin:/usr/local/bin:/usr/bin:/bin
#   */10 * * * * close-finished-oncall-sessions.sh >> /home/vps/.local/state/osinara-oncall-cleanup.log 2>&1
set -euo pipefail

readonly ONCALL_PROMPT_PREFIX="Ты дежурный по проекту Osinara."
readonly IDLE_MINUTES=20
readonly CLAUDE_HOME="${1:-$HOME/.claude}"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

start_ticks() {
  local stat
  stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  stat="${stat##*) }"
  # shellcheck disable=SC2086 # the fields are split on purpose
  set -- $stat
  printf '%s' "${20}"
}

started_by_oncall() {
  tr '\0' '\n' < "/proc/$1/cmdline" 2>/dev/null | grep -qF -- "$ONCALL_PROMPT_PREFIX"
}

# Messages a person wrote: tool results, Claude Code's own notes and subagent threads are not theirs.
human_message_count() {
  jq -s '[.[] | select(.type == "user" and (.isMeta | not) and (.isSidechain | not))
    | select((.message.content | type) == "string"
      or ([.message.content[]?.type] | index("tool_result") | not))] | length' "$1"
}

terminal_handle() {
  tr '\0' '\n' < "/proc/$1/environ" 2>/dev/null | sed -n 's/^ORCA_TERMINAL_HANDLE=//p'
}

close_if_finished() {
  local session_file="$1" pid session_id cwd recorded_start transcript quiet handle
  pid="$(jq -r '.pid // empty' "$session_file")"
  session_id="$(jq -r '.sessionId // empty' "$session_file")"
  cwd="$(jq -r '.cwd // empty' "$session_file")"
  recorded_start="$(jq -r '.procStart // empty' "$session_file")"
  [[ "$pid" =~ ^[0-9]+$ && -n "$session_id" && -n "$cwd" && -n "$recorded_start" ]] || return 0
  [[ "$(start_ticks "$pid" || true)" == "$recorded_start" ]] || return 0
  started_by_oncall "$pid" || return 0
  transcript="${CLAUDE_HOME}/projects/$(printf '%s' "$cwd" | sed 's/[^A-Za-z0-9]/-/g')/${session_id}.jsonl"
  [[ -f "$transcript" ]] || return 0
  [[ "$(human_message_count "$transcript")" == "1" ]] || return 0
  quiet=$(( $(date +%s) - $(stat -c %Y "$transcript") ))
  (( quiet >= IDLE_MINUTES * 60 )) || return 0
  handle="$(terminal_handle "$pid")"
  [[ -n "$handle" ]] || { log "ONCALL_SESSION_TERMINAL_UNKNOWN pid=${pid} session=${session_id}"; return 1; }
  # Called as an `if` condition, where errexit is off: every failure below is checked by hand.
  orca terminal close --terminal "$handle" --tab --json >/dev/null || return 1
  log "ONCALL_SESSION_CLOSED pid=${pid} session=${session_id} terminal=${handle} quiet_minutes=$(( quiet / 60 ))"
}

failed=0
for session_file in "$CLAUDE_HOME"/sessions/*.json; do
  [[ -f "$session_file" ]] || continue
  if ! close_if_finished "$session_file"; then
    log "ONCALL_SESSION_CLOSE_FAILED file=${session_file}"
    failed=1
  fi
done
exit "$failed"
