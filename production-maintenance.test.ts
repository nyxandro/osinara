/** Deploy must defer before stopping containers when runtime work cannot settle. */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function run(script: string) {
  return spawnSync("bash", ["-c", `set -euo pipefail
source scripts/production-deploy/backup.sh
fail() { printf '%s\\n' "$1" >&2; return 1; }
log_event() { :; }
${script}`], { encoding: "utf8" });
}

describe("production maintenance", () => {
  it("waits for draining, freezes admission, and rechecks before stopping", () => {
    const result = run(`
MAINTENANCE_TOKEN=123e4567-e89b-42d3-a456-426614174000
require_runtime_admission() { :; }
set_runtime_phase() { printf 'phase=%s\\n' "$1"; }
runtime_is_idle() { printf 'idle-check\\n'; return 0; }
prepare_runtime_update
printf 'safe-to-stop\\n'
resume_runtime_admission
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "phase=draining", "idle-check", "phase=frozen", "idle-check", "safe-to-stop", "phase=ready",
    ]);
  });

  it("does not stop or migrate when runtime is busy", () => {
    const result = run(`
require_runtime_admission() { :; }
set_runtime_phase() { printf 'phase=%s\\n' "$1"; }
runtime_is_idle() { return 1; }
sleep() { :; }
prepare_runtime_update
printf 'unsafe-stop\\n'
`);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("unsafe-stop");
    expect(result.stdout).toContain("phase=ready");
    expect(result.stderr).toContain("DEPLOY_RUNTIME_BUSY");
  });

  it("does not resume another deployment's maintenance state", () => {
    const result = run(`
MAINTENANCE_TOKEN=123e4567-e89b-42d3-a456-426614174000
psql_current() { printf '\\n'; }
set_runtime_phase ready
`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_MAINTENANCE_OWNERSHIP_LOST");
  });
  it("propagates failed admission restoration even inside an if condition", () => {
    const result = run(`
MAINTENANCE_ACTIVE=1
set_runtime_phase() { return 1; }
if ! resume_runtime_admission; then printf 'recovery-failed\\n'; fi
printf 'active=%s\\n' "$MAINTENANCE_ACTIVE"
`);
    expect(result.stdout).toContain("recovery-failed");
    expect(result.stdout).toContain("active=1");
  });
  it("immediately defers if a human answer is pending instead of trapping it behind paused messages", () => {
    const result = run(`
require_runtime_admission() { :; }
set_runtime_phase() { printf 'phase=%s\\n' "$1"; }
runtime_is_idle() { return 3; }
sleep() { printf 'should-not-wait\\n'; }
prepare_runtime_update
printf 'unsafe-stop\\n'
`);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("phase=ready");
    expect(result.stdout).not.toContain("should-not-wait");
    expect(result.stdout).not.toContain("unsafe-stop");
    expect(result.stderr).toContain("DEPLOY_APPROVAL_PENDING");
  });
});
