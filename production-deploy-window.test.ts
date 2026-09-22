/**
 * Deployment noise window tests.
 *
 * A release stops and restarts every production container. Without an explicit signal the
 * observability hub reads that as an outage and wakes the duty agent on every deployment.
 *
 * Constructs covered:
 * - The published metric carries a deadline, so a killed deployment cannot silence alerts forever.
 * - Closing the window is immediate, which is how a failed release becomes visible at once.
 * - Absent collector storage and every way the write can fail never abort an approved release.
 * - The entrypoint opens the window only once a deployment is certain and closes it on every exit.
 * - Closing writes only when a window exists: a tick that deployed nothing leaves the mark be,
 *   which is what keeps the alert that allows a grace period on top of it from being silenced.
 * - The systemd unit grants the write access that `ProtectSystem=strict` would otherwise deny.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  // The deployment runs under `set -Eeuo pipefail` with an ERR trap that aborts the release and
  // reports an ambiguous result to the owner. Directory permissions cannot express any of this:
  // the deployment is root, for whom every directory is writable. Only attempting the write tells
  // the truth, so each way it can fail is exercised under exactly those shell settings.
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

  it("leaves a closed window alone on a tick that deployed nothing", () => {
    const directory = makeDirectory("osinara-window-tick-");
    const metricPath = join(directory, "osinara-deploy-window.prom");

    const release = runShell(`
      source scripts/production-deploy/common.sh
      open_deploy_window ${JSON.stringify(metricPath)}
      close_deploy_window ${JSON.stringify(metricPath)}
    `);
    expect(release.status, release.stderr).toBe(0);
    const closed = readDeadline(metricPath).deadline;

    // The next timer tick is a separate process that finds no approved proposal and still reaches
    // the exit trap. Re-stamping the mark here is what silenced the ingress alert around the
    // clock: that rule allows a grace period on top of the mark, and a mark refreshed every
    // minute never falls far enough behind for the grace to expire. `date` is stubbed far into
    // the future so a rewrite is unmistakable.
    const tick = runShell(`
      source scripts/production-deploy/common.sh
      date() { printf '%s\\n' 9999999999; }
      close_deploy_window ${JSON.stringify(metricPath)}
    `);

    expect(tick.status, tick.stderr).toBe(0);
    expect(readDeadline(metricPath).deadline).toBe(closed);
  });

  it("does not abort the run when the tick finds the window already closed", () => {
    const directory = makeDirectory("osinara-window-guard-");
    const metricPath = join(directory, "osinara-deploy-window.prom");
    const setup = runShell(`
      source scripts/production-deploy/common.sh
      open_deploy_window ${JSON.stringify(metricPath)}
      close_deploy_window ${JSON.stringify(metricPath)}
    `);
    // Without a written sample the tick below meets no file at all, returns early and proves
    // nothing about the guard it is meant to exercise.
    expect(setup.status, setup.stderr).toBe(0);
    expect(existsSync(metricPath)).toBe(true);

    // The guard answers "there is no window" by failing, which is the exact shape `set -e` and the
    // release's ERR trap abort on. Deciding not to write must never end a run.
    const result = runShell(`
      set -E
      source scripts/production-deploy/common.sh
      trap 'printf "RUN-ABORTED\\n"; exit 9' ERR
      close_deploy_window ${JSON.stringify(metricPath)}
      printf 'tick-continues\\n'
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("RUN-ABORTED");
    expect(result.stdout).toContain("tick-continues");
  });

  it("closes a window this run opened even after its deadline has passed", () => {
    const directory = makeDirectory("osinara-window-overrun-");
    const metricPath = join(directory, "osinara-deploy-window.prom");

    // systemd allows a release forty-five minutes and the window it announces lasts thirty, so a
    // slow release can outlive its own deadline. It still has to hand the queue its grace period
    // on the way out: without that the alert fires the moment a healthy release finishes.
    const before = Math.floor(Date.now() / 1000);
    const result = runShell(`
      source scripts/production-deploy/common.sh
      date() { printf '%s\\n' 1000000000; }
      open_deploy_window ${JSON.stringify(metricPath)}
      unset -f date
      close_deploy_window ${JSON.stringify(metricPath)}
    `);
    const after = Math.floor(Date.now() / 1000);

    expect(result.status, result.stderr).toBe(0);
    const { deadline } = readDeadline(metricPath);
    expect(deadline).toBeGreaterThanOrEqual(before);
    expect(deadline).toBeLessThanOrEqual(after);
  });

  it("repairs a sample nothing can parse instead of leaving it for good", () => {
    const directory = makeDirectory("osinara-window-corrupt-");
    const metricPath = join(directory, "osinara-deploy-window.prom");
    writeFileSync(metricPath, "half a line nobody can read\n");

    // The collector cannot read this either, so the hub reports broken textfile metrics until
    // someone intervenes. Refusing to touch it would make that permanent; one valid write ends it.
    const result = runShell(`
      source scripts/production-deploy/common.sh
      close_deploy_window ${JSON.stringify(metricPath)}
    `);
    const after = Math.floor(Date.now() / 1000);

    expect(result.status, result.stderr).toBe(0);
    expect(readDeadline(metricPath).deadline).toBeLessThanOrEqual(after);
  });

  it("repairs a file whose last sample is fine but which carries anything else", () => {
    const directory = makeDirectory("osinara-window-mixed-");
    const metricPath = join(directory, "osinara-deploy-window.prom");
    const past = Math.floor(Date.now() / 1000) - 3_600;
    // The collector parses the file whole, so one stray line or a duplicate sample costs the valid
    // sample next to it as well. Looking at the last sample alone would leave that for good.
    writeFileSync(metricPath, [
      "half a line nobody can read",
      `deploy_window_end_timestamp_seconds{project="osinara-production"} ${past}`,
      `deploy_window_end_timestamp_seconds{project="osinara-production"} ${past}`,
      "",
    ].join("\n"));

    const result = runShell(`
      source scripts/production-deploy/common.sh
      close_deploy_window ${JSON.stringify(metricPath)}
    `);

    expect(result.status, result.stderr).toBe(0);
    const content = readFileSync(metricPath, "utf8");
    expect(content).not.toContain("half a line");
    expect(content.match(/^deploy_window_end_timestamp_seconds\{/gmu)).toHaveLength(1);
  });

  it("leaves an exact closed sample untouched", () => {
    const directory = makeDirectory("osinara-window-rest-");
    const metricPath = join(directory, "osinara-deploy-window.prom");
    const setup = runShell(`
      source scripts/production-deploy/common.sh
      publish_deploy_window ${JSON.stringify(metricPath)} 1000
    `);
    expect(setup.status, setup.stderr).toBe(0);
    const before = readFileSync(metricPath, "utf8");

    const result = runShell(`
      source scripts/production-deploy/common.sh
      close_deploy_window ${JSON.stringify(metricPath)}
    `);

    // The ordinary resting state: an old deadline the tick has no business rewriting.
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(metricPath, "utf8")).toBe(before);
  });

  it("clears a window a killed release left in the future", () => {
    const directory = makeDirectory("osinara-window-stale-");
    const metricPath = join(directory, "osinara-deploy-window.prom");

    // A release killed between opening the window and running its trap leaves a deadline ahead of
    // now. Nothing else will ever close it, so the next tick has to.
    const killed = runShell(`
      source scripts/production-deploy/common.sh
      open_deploy_window ${JSON.stringify(metricPath)}
    `);
    expect(killed.status, killed.stderr).toBe(0);
    expect(readDeadline(metricPath).deadline).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const tick = runShell(`
      source scripts/production-deploy/common.sh
      close_deploy_window ${JSON.stringify(metricPath)}
    `);
    const after = Math.floor(Date.now() / 1000);

    expect(tick.status, tick.stderr).toBe(0);
    expect(readDeadline(metricPath).deadline).toBeLessThanOrEqual(after);
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
    // Every stretch that can run long gets a fresh window: the image pull has no bound of its
    // own, and the backup runs while the containers are already down. A window opened once at the
    // start could expire mid-downtime and hand the duty agent the outage it was meant to explain.
    const stop = main.indexOf("stop_current_services");
    const migration = main.indexOf("MIGRATION_STARTED=1");
    expect(main.lastIndexOf("open_deploy_window", stop)).toBeGreaterThan(main.indexOf("preflight_backup"));
    expect(main.lastIndexOf("open_deploy_window", migration)).toBeGreaterThan(stop);
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
