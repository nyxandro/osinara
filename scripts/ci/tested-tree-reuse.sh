#!/bin/bash
# Decides whether a push to main may publish without running both test suites again (#577).
#
# A release PR merges develop into main, and while main is an ancestor of develop the merge commit has
# exactly the tree of develop's head. If a push run of this workflow for a parent with that same tree
# passed both suites, the same files — workflow and tests included — already passed them. Anything less
# than that proof runs the suites as before. Writes `reused` (and `run-url` when true) to GITHUB_OUTPUT.
set -euo pipefail

readonly WORKFLOW_PATH=".github/workflows/ci-release.yaml"
readonly REQUIRED_JOBS='["Docker Compose test suite", "Memory retrieval evals"]'

: "${GITHUB_OUTPUT:?CI_TESTED_TREE_OUTPUT_MISSING: GITHUB_OUTPUT is required}"
: "${GITHUB_REPOSITORY:?CI_TESTED_TREE_REPOSITORY_MISSING: GITHUB_REPOSITORY is required}"

# Prints the URL of a push run of this workflow for that commit in which both suites succeeded, nothing
# when there is none. Every lookup failure returns non-zero explicitly: a caller's `if` turns off errexit.
tested_run_url() {
  local commit="$1" runs candidates run_id run_url jobs verdict
  runs="$(gh api "repos/${GITHUB_REPOSITORY}/actions/workflows/ci-release.yaml/runs?head_sha=${commit}&event=push&status=success&per_page=100")" ||
    return 1
  candidates="$(jq -r --arg commit "$commit" --arg repository "$GITHUB_REPOSITORY" --arg path "$WORKFLOW_PATH" '
    .workflow_runs[]
    | select(.head_sha == $commit and .event == "push" and .conclusion == "success"
        and .path == $path and .head_repository.full_name == $repository)
    | [.id, .html_url] | @tsv' <<<"$runs")" || return 1
  while IFS=$'\t' read -r run_id run_url; do
    [[ -n "$run_id" ]] || continue
    jobs="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/jobs?per_page=100")" || return 1
    # Both suites must have run and passed: a skipped suite proves nothing.
    verdict=0
    jq -e --argjson required "$REQUIRED_JOBS" \
      '($required - [.jobs[] | select(.conclusion == "success") | .name]) == []' <<<"$jobs" >/dev/null ||
      verdict=$?
    if ((verdict == 0)); then
      printf '%s\n' "$run_url"
      return 0
    fi
    # `jq -e` exits 1 when the suites did not both pass; above that it could not read the answer at all.
    if ((verdict != 1)); then
      printf 'Unreadable jobs of run %s (jq exit %s)\n' "$run_id" "$verdict" >&2
      return 1
    fi
  done <<<"$candidates"
  return 0
}

head_tree="$(git rev-parse 'HEAD^{tree}')"
read -r -a commits <<<"$(git rev-list --parents -n 1 HEAD)"
lookup_errors="$(mktemp)"
trap 'rm -f -- "$lookup_errors"' EXIT
for parent in "${commits[@]:1}"; do
  [[ "$(git rev-parse "${parent}^{tree}")" == "$head_tree" ]] || continue
  # A lookup GitHub does not answer proves nothing: the suites run, and the warning says why.
  if ! run_url="$(tested_run_url "$parent" 2>"$lookup_errors")"; then
    printf '::warning::Could not read the test runs of %s, running the suites: %s\n' \
      "$parent" "$(tr '\n' ' ' <"$lookup_errors")"
    printf 'reused=false\n' >> "$GITHUB_OUTPUT"
    exit 0
  fi
  if [[ -n "$run_url" ]]; then
    printf '::notice::Tree %s already passed both suites in %s; publishing without running them again\n' \
      "$head_tree" "$run_url"
    printf 'reused=true\nrun-url=%s\n' "$run_url" >> "$GITHUB_OUTPUT"
    exit 0
  fi
done
printf '::notice::No push run passed both suites for tree %s; running them\n' "$head_tree"
printf 'reused=false\n' >> "$GITHUB_OUTPUT"
