/**
 * Deployment noise window tests.
 *
 * A release stops and restarts every production container. Without an explicit signal the
 * observability hub reads that as an outage and wakes the duty agent on every deployment.
 *
 * Constructs covered:
 * - The published metric carries a deadline, so a killed deployment cannot silence alerts forever.
 * - Closing the window is immediate, which is how a failed release becomes visible at once.
 * - Absent or unwritable collector storage is recorded and never aborts an approved release.
 * - The entrypoint opens the window only once a deployment is certain and closes it on every exit.
 * - The systemd unit grants the write access that `ProtectSystem=strict` would otherwise deny.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = new URL("./", import.meta.url).pathname;
const temporaryDirectories: string[] = [];

function runShell(source: string) {
  return spawnSync("/bin/bash", ["-c", `set -euo pipefail\n${source}`], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env },
  });
}

function makeDirectory(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function readDeadline(metricPath: string) {
  const contents = readFileSync(metricPath, "utf8");
  const match = contents.match(
    /^deploy_window_end_timestamp_seconds\{project="osinara-production"\} (\d+)$/m,
  );
  expect(match, `no sample line in:\n${contents}`).not.toBeNull();
  return { contents, deadline: Number(match![1]) };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    chmodSync(directory, 0o700);
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("deployment noise window", () => {
  it("publishes a deadline ahead of now and declares the metric for the collector", () => {
    const directory = makeDirectory("osinara-window-open-");
    const metricPath = join(directory, "osinara-deploy-window.prom");

    const before = Math.floor(Date.now() / 1000);
    const result = runShell(`
      source scripts/production-deploy/common.sh
      open_deploy_window ${JSON.stringify(metricPath)}
      printf 'window=%s\\n' "$DEPLOY_WINDOW_SECONDS"
    `);
    const after = Math.floor(Date.now() / 1000);

    expect(result.status, result.stderr).toBe(0);
    const { contents, deadline } = readDeadline(metricPath);
    const windowSeconds = Number(result.stdout.match(/window=(\d+)/)![1]);
    expect(deadline).toBeGreaterThanOrEqual(before + windowSeconds);
    expect(deadline).toBeLessThanOrEqual(after + windowSeconds);
    expect(contents).toContain("# TYPE deploy_window_end_timestamp_seconds gauge");
    expect(contents).toContain("# HELP deploy_window_end_timestamp_seconds");
    // A half-written sample makes the collector drop every textfile metric at once.
    expect(readdirSync(directory)).toEqual(["osinara-deploy-window.prom"]);
  });

  it("outlives no deployment: the published window is bounded by the systemd start timeout", () => {
    const unit = readFileSync(join(projectRoot, "infra/systemd/osinara-deploy.service"), "utf8");
    const timeoutMinutes = Number(unit.match(/TimeoutStartSec=(\d+)min/)![1]);
    const result = runShell(`
      source scripts/production-deploy/common.sh
      printf '%s\\n' "$DEPLOY_WINDOW_SECONDS"
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(Number(result.stdout.trim())).toBeLessThan(timeoutMinutes * 60);
  });

  it("closes the window immediately so a failed release stops being suppressed", () => {
    const directory = makeDirectory("osinara-window-close-");
    const metricPath = join(directory, "osinara-deploy-window.prom");

    const result = runShell(`
      source scripts/production-deploy/common.sh
      open_deploy_window ${JSON.stringify(metricPath)}
      close_deploy_window ${JSON.stringify(metricPath)}
    `);
    const after = Math.floor(Date.now() / 1000);

    expect(result.status, result.stderr).toBe(0);
    expect(readDeadline(metricPath).deadline).toBeLessThanOrEqual(after);
  });

  it("records absent collector storage and still completes the deployment", () => {
    const directory = makeDirectory("osinara-window-absent-");
    const metricPath = join(directory, "missing", "osinara-deploy-window.prom");

    const result = runShell(`
      source scripts/production-deploy/common.sh
      open_deploy_window ${JSON.stringify(metricPath)}
      printf 'deployment-continues\\n'
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("deployment-continues");
    expect(result.stderr).toContain("DEPLOY_WINDOW_METRIC_UNAVAILABLE");
    expect(existsSync(metricPath)).toBe(false);
  });

  it("records unwritable collector storage and still completes the deployment", () => {
    const directory = makeDirectory("osinara-window-readonly-");
    const metricPath = join(directory, "osinara-deploy-window.prom");
    writeFileSync(metricPath, "stale\n", "utf8");
    chmodSync(directory, 0o500);

    const result = runShell(`
      source scripts/production-deploy/common.sh
      open_deploy_window ${JSON.stringify(metricPath)}
      printf 'deployment-continues\\n'
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("deployment-continues");
    expect(result.stderr).toContain("DEPLOY_WINDOW_METRIC_UNAVAILABLE");
  });

  // The deployment runs under `set -Eeuo pipefail` with an ERR trap that aborts the release and
  // reports an ambiguous result to the owner. These two branches are the ones a real server
  // reaches — the readable/writable guard above cannot fail for root — so they are exercised
  // under exactly those shell settings.
  it.each([
    // A filesystem the kernel remounted read-only after a disk error: the directory passed the
    // guard, and then every write against it fails, the cleanup of the temporary file included.
    ["a read-only filesystem", "mv() { return 1; }\n      rm() { return 1; }"],
    ["a failing temporary file", "mktemp() { return 1; }"],
    ["a failing mode change", "chmod() { return 1; }"],
  ])("does not abort the release on %s", (_name, stub) => {
    const directory = makeDirectory("osinara-window-err-");
    const metricPath = join(directory, "osinara-deploy-window.prom");

    const result = runShell(`
      set -E
      source scripts/production-deploy/common.sh
      trap 'printf "RELEASE-ABORTED\\n"; exit 9' ERR
      ${stub}
      open_deploy_window ${JSON.stringify(metricPath)}
      printf 'deployment-continues\\n'
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("RELEASE-ABORTED");
    expect(result.stdout).toContain("deployment-continues");
    expect(result.stderr).toContain("DEPLOY_WINDOW_METRIC_UNAVAILABLE");
    // A failed publish must not leave the collector a sample nobody will ever replace.
    expect(readdirSync(directory).filter((name) => name.endsWith(".prom"))).toEqual([]);
  });

  it("stays silent on a host that has never published a window", () => {
    const directory = makeDirectory("osinara-window-quiet-");
    const metricPath = join(directory, "osinara-deploy-window.prom");

    // Nearly every timer tick reaches the exit trap without making a release. On a host with no
    // collector that would otherwise report a problem once a minute, forever.
    const result = runShell(`
      source scripts/production-deploy/common.sh
      close_deploy_window ${JSON.stringify(metricPath)}
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(metricPath)).toBe(false);
  });

  it("publishes exactly the metric and project the alert rules stand down on", () => {
    const common = readFileSync(join(projectRoot, "scripts/production-deploy/common.sh"), "utf8");
    const sample = common.match(/printf '(\w+)\{project="([^"]+)"\} %s\\n'/)!;
    const [, metricName, projectLabel] = sample;
    const selector = `${metricName}{project="${projectLabel}"}`;

    // The two halves live in different files and break silently: rename the metric or the project
    // on one side and every release starts waking the duty agent again, with nothing failing.
    for (const path of [
      "infra/monitoring/rules/metrics/osinara.yaml",
      "infra/monitoring/rules/metrics/osinara-state.yaml",
    ]) {
      const rules = readFileSync(join(projectRoot, path), "utf8");
      const clauses = rules.match(/unless on\(\) \S+\{project="[^"]+"\}/g) ?? [];
      expect(clauses.length, `${path} must stand down on a release`).toBeGreaterThan(0);
      for (const clause of clauses) {
        expect(clause, `${path} must suppress on the published metric`).toContain(selector);
      }
    }
  });

  it("leaves backward-looking and release-watching rules alert", () => {
    const state = readFileSync(
      join(projectRoot, "infra/monitoring/rules/metrics/osinara-state.yaml"),
      "utf8",
    );
    const metrics = readFileSync(
      join(projectRoot, "infra/monitoring/rules/metrics/osinara.yaml"),
      "utf8",
    );

    // Suppressing this one would remove the only rule that notices a release which never finished.
    const maintenance = state.slice(
      state.indexOf("- alert: OsinaraRuntimeMaintenanceStuck"),
      state.indexOf("- alert: OsinaraModelSuccessStale"),
    );
    expect(maintenance).not.toContain("unless on()");

    // These count log lines already written; suppressing them would hide a burst that happened
    // just before the release started.
    expect(metrics.slice(metrics.indexOf("name: osinara-logs"))).not.toContain("unless on()");
  });

  it("opens the window only after a deployment is certain and closes it on every exit", () => {
    const entrypoint = readFileSync(join(projectRoot, "scripts/production-deploy.sh"), "utf8");
    const main = entrypoint.slice(entrypoint.indexOf("main() {"));

    // Every timer tick runs this unit; almost all of them find no approved proposal and return
    // before here. Opening earlier would keep production alerts suppressed around the clock.
    expect(main.indexOf("open_deploy_window")).toBeGreaterThan(main.indexOf("claim_approved_proposal"));
    expect(main.indexOf("open_deploy_window")).toBeLessThan(main.indexOf("stop_current_services"));
    // The exit trap belongs to the lock owner, so closing can never cut another deployment short.
    expect(main.indexOf("trap 'close_deploy_window")).toBeGreaterThan(main.indexOf("flock -n 9"));
  });

  it("grants the deployment write access the collector directory needs", () => {
    const unit = readFileSync(join(projectRoot, "infra/systemd/osinara-deploy.service"), "utf8");
    const common = readFileSync(join(projectRoot, "scripts/production-deploy/common.sh"), "utf8");
    const metricPath = common.match(/DEPLOY_WINDOW_METRIC="([^"]+)"/)![1];
    // A leading dash marks a path systemd ignores when it does not exist.
    const readWritePaths = unit
      .match(/ReadWritePaths=(.+)/)![1]
      .split(" ")
      .map((entry) => entry.replace(/^-/, ""));

    // ProtectSystem=strict makes the rest of the filesystem read-only: without this entry the
    // window would silently never be published and every release would wake the duty agent.
    expect(readWritePaths.some((path) => metricPath.startsWith(`${path}/`))).toBe(true);
  });
});
