/**
 * Deployment claim tests.
 *
 * Constructs covered:
 * - `claim_approved_proposal` and `adopt_claimed_proposal` read the same stored manifest columns
 *   into the same variables, so a release a resumed controller validates is the one approved.
 * - `adopt_claimed_proposal` binds the claim before reading it, so a failed adoption is still
 *   recorded against the handed-over lease.
 */
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const projectRoot = new URL("./", import.meta.url).pathname;
const PROPOSAL = "11111111-1111-4111-8111-111111111111";
const LEASE = "22222222-2222-4222-8222-222222222222";
const MANIFEST = [
  "1.4.0",
  "a".repeat(40),
  "b".repeat(64),
  `ghcr.io/nyxandro/osinara-app@sha256:${"1".repeat(64)}`,
  `ghcr.io/nyxandro/osinara-cli-proxy@sha256:${"2".repeat(64)}`,
  `ghcr.io/nyxandro/osinara-edge@sha256:${"3".repeat(64)}`,
  `ghcr.io/nyxandro/osinara-sandbox-egress-proxy@sha256:${"4".repeat(64)}`,
  `ghcr.io/nyxandro/osinara-sandbox-runner@sha256:${"5".repeat(64)}`,
  `ghcr.io/nyxandro/osinara-sandbox-runtime@sha256:${"6".repeat(64)}`,
];
const PRINT_CLAIM = `
  printf '%s|' "$PROPOSAL_ID" "$LEASE_TOKEN" "$REQUESTED_VERSION" "$OWNER_CHAT_ID" "$STORED_VERSION" \\
    "$STORED_COMMIT" "$STORED_COMPOSE_SHA" "$STORED_APP" "$STORED_CLI_PROXY" "$STORED_EDGE" \\
    "$STORED_EGRESS" "$STORED_RUNNER" "$STORED_RUNTIME"
`;

function runShell(source: string, row: readonly string[] = []) {
  return spawnSync("/bin/bash", ["-c", `set -euo pipefail
    source scripts/production-deploy/common.sh
    source scripts/production-deploy/database.sh
    log_event() { printf '%s\\n' "$1" >&2; }
    fail() { printf '%s %s\\n' "$1" "$2" >&2; return 1; }
    ${source}`], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, DATABASE_ROW: row.join("\t") },
  });
}

/** A `psql_current` stub that prints the tab-separated row passed as DATABASE_ROW. */
const DATABASE = `psql_current() { cat >/dev/null; printf '%s\\n' "$DATABASE_ROW"; }`;

describe("claim and adoption of an approved release", () => {
  it("reads the same manifest into the same variables whether claimed or adopted after a handover", () => {
    const claimed = runShell(`
      ${DATABASE}
      claim_approved_proposal
      LEASE_TOKEN=${LEASE}
      ${PRINT_CLAIM}
    `, [PROPOSAL, "1.4.0", "777", ...MANIFEST]);
    const adopted = runShell(`
      ${DATABASE}
      adopt_claimed_proposal ${PROPOSAL} ${LEASE}
      ${PRINT_CLAIM}
    `, ["1.4.0", "777", ...MANIFEST]);

    expect(claimed.status, claimed.stderr).toBe(0);
    expect(adopted.status, adopted.stderr).toBe(0);
    expect(adopted.stdout).toBe(claimed.stdout);
    expect(adopted.stdout).toBe(`${[PROPOSAL, LEASE, "1.4.0", "777", ...MANIFEST].join("|")}|`);
  });

  it("keeps the handed-over claim bound when it can no longer be adopted", () => {
    const result = runShell(`
      psql_current() { cat >/dev/null; }
      if ! adopt_claimed_proposal ${PROPOSAL} ${LEASE}; then
        printf 'bound %s %s\\n' "$PROPOSAL_ID" "$LEASE_TOKEN"
      fi
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("DEPLOY_RESUMED_CLAIM_INVALID");
    expect(result.stdout).toBe(`bound ${PROPOSAL} ${LEASE}\n`);
  });

  it("refuses a malformed handover before touching the database", () => {
    const result = runShell(`
      psql_current() { echo "database touched" >&2; }
      adopt_claimed_proposal not-a-uuid ${LEASE}
    `);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_RESUME_ARGUMENT_INVALID");
    expect(result.stderr).not.toContain("database touched");
  });
});
