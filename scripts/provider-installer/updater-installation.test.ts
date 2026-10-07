/**
 * Self-updating deployment controller installation tests.
 *
 * Constructs covered:
 * - `findMissingHostCommands`: the controller's host tools are checked before any host change.
 * - `installUpdaterFromImage`: controller, launcher, version link, and units come only from the
 *   release app image and land with the modes the launcher verifies.
 * - `enableUpdater` / `removeUpdaterUnits`: the systemd side of enabling and rollback.
 * - `assertUpdaterActive`: `osinara doctor` reports a stopped update timer.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runHostCommand } from "./process-runner.js";
import {
  assertUpdaterActive,
  enableUpdater,
  findMissingHostCommands,
  installUpdaterFromImage,
  removeUpdaterUnits,
  type UpdaterLayout,
} from "./updater-installation.js";

const APP_IMAGE = `ghcr.io/nyxandro/osinara-app@sha256:${"a".repeat(64)}`;
const CONTROLLER_FILES: Record<string, string> = {
  "common.sh": "#!/bin/bash\n",
  "installation-compose.jq": ".\n",
  "launcher.sh": "#!/bin/bash\n# launcher\n",
  "main.sh": "#!/bin/bash\n# main\n",
};
const UNIT_FILES: Record<string, string> = {
  "osinara-deploy.service": "[Service]\nExecStart=/opt/osinara/bin/production-deploy.sh\n",
  "osinara-deploy.timer": "[Timer]\nOnUnitActiveSec=1min\n",
};
const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function writeTree(directory: string, files: Record<string, string>): void {
  mkdirSync(directory, { recursive: true });
  for (const [name, source] of Object.entries(files)) writeFileSync(join(directory, name), source, "utf8");
}

/** The `/app/deploy` tree the app image carries, as `tar -c` streams it. */
function imageTree(change?: (root: string) => void): Buffer {
  const root = temporaryDirectory("osinara-updater-image-");
  writeTree(join(root, "controller"), CONTROLLER_FILES);
  writeTree(join(root, "systemd"), UNIT_FILES);
  change?.(root);
  const archive = spawnSync("tar", ["-c", "-C", root, "."]);
  if (archive.status !== 0) throw new Error(archive.stderr.toString("utf8"));
  return archive.stdout;
}

function host(): { layout: UpdaterLayout; root: string } {
  const root = temporaryDirectory("osinara-updater-host-");
  mkdirSync(join(root, "opt/osinara/.install-attempt"), { recursive: true });
  mkdirSync(join(root, "etc/systemd/system"), { recursive: true });
  return {
    layout: {
      binDir: join(root, "opt/osinara/bin"),
      controllerRoot: join(root, "opt/osinara/bin/controller"),
      launcherPath: join(root, "opt/osinara/bin/production-deploy.sh"),
      stagingDir: join(root, "opt/osinara/.install-attempt/deploy"),
      systemdDir: join(root, "etc/systemd/system"),
    },
    root,
  };
}

/** Docker serves `archive`; tar runs for real; systemctl is recorded. */
function runner(archive: Buffer, calls: string[]): typeof runHostCommand {
  return async (input) => {
    calls.push(`${input.command} ${input.args.join(" ")}`);
    if (input.command === "docker") return archive;
    if (input.command === "tar" || input.command === "bash") return await runHostCommand(input);
    if (input.command === "systemctl") return Buffer.alloc(0);
    throw new Error(`unexpected command ${input.command}`);
  };
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("updater host prerequisites", () => {
  it("names every controller tool the host cannot execute", async () => {
    const first = temporaryDirectory("osinara-updater-path-a-");
    const second = temporaryDirectory("osinara-updater-path-b-");
    writeFileSync(join(first, "docker"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(second, "flock"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(second, "jq"), "not executable\n", { mode: 0o644 });

    await expect(findMissingHostCommands([first, second], ["docker", "flock", "jq", "systemctl"]))
      .resolves.toEqual(["jq", "systemctl"]);
  });
});

describe("updater installation", () => {
  it("installs the controller the release image carries and the units that start it", async () => {
    const { layout } = host();
    const calls: string[] = [];

    const units = await installUpdaterFromImage({
      appImage: APP_IMAGE,
      layout,
      releaseVersion: "0.41.0",
      run: runner(imageTree(), calls),
    });

    const versionDir = join(layout.controllerRoot, "v0.41.0");
    expect(calls[0]).toBe(
      `docker run --rm --network none --entrypoint /bin/tar ${APP_IMAGE} -c -C /app/deploy .`,
    );
    expect(readlinkSync(join(layout.controllerRoot, "current"))).toBe("v0.41.0");
    expect(readFileSync(join(versionDir, "main.sh"), "utf8")).toBe(CONTROLLER_FILES["main.sh"]);
    expect(readFileSync(layout.launcherPath, "utf8")).toBe(CONTROLLER_FILES["launcher.sh"]);
    expect(mode(layout.binDir)).toBe(0o750);
    expect(mode(layout.controllerRoot)).toBe(0o750);
    expect(mode(versionDir)).toBe(0o750);
    expect(mode(join(versionDir, "installation-compose.jq"))).toBe(0o640);
    expect(mode(layout.launcherPath)).toBe(0o750);
    expect(units).toEqual([
      join(layout.systemdDir, "osinara-deploy.service"),
      join(layout.systemdDir, "osinara-deploy.timer"),
    ]);
    for (const unit of units) expect(mode(unit)).toBe(0o644);
    expect(readFileSync(units[1]!, "utf8")).toBe(UNIT_FILES["osinara-deploy.timer"]);
    expect(calls.at(-1)).toBe("systemctl daemon-reload");
    expect(existsSync(layout.stagingDir)).toBe(false);
  });

  it.each([
    ["an unexpected controller file", (root: string) => writeFileSync(join(root, "controller/notes.txt"), "x")],
    ["a nested controller directory", (root: string) => writeTree(join(root, "controller/lib"), { "x.sh": "" })],
    ["no main.sh", (root: string) => rmSync(join(root, "controller/main.sh"))],
    ["an extra unit", (root: string) => writeFileSync(join(root, "systemd/other.timer"), "")],
    ["no timer unit", (root: string) => rmSync(join(root, "systemd/osinara-deploy.timer"))],
    ["an unexpected top-level entry", (root: string) => writeTree(join(root, "extra"), {})],
    ["a module that is not valid shell", (root: string) => writeFileSync(join(root, "controller/common.sh"), "if then fi\n")],
  ])("refuses a release image whose deploy tree has %s", async (_case, change) => {
    const { layout } = host();
    const calls: string[] = [];

    await expect(installUpdaterFromImage({
      appImage: APP_IMAGE,
      layout,
      releaseVersion: "0.41.0",
      run: runner(imageTree(change), calls),
    })).rejects.toMatchObject({ code: "OSINARA_INSTALL_UPDATER_INVALID" });
    expect(existsSync(layout.controllerRoot)).toBe(false);
    expect(existsSync(join(layout.systemdDir, "osinara-deploy.service"))).toBe(false);
  });

  it("installs the controller and units this repository ships", async () => {
    const { layout } = host();
    const projectRoot = new URL("../../", import.meta.url).pathname;
    const repositoryTree = temporaryDirectory("osinara-updater-repository-");
    for (const [from, to] of [["scripts/production-deploy", "controller"], ["infra/systemd", "systemd"]]) {
      const copy = spawnSync("cp", ["-R", join(projectRoot, from), join(repositoryTree, to)]);
      if (copy.status !== 0) throw new Error(copy.stderr.toString("utf8"));
    }
    const archive = spawnSync("tar", ["-c", "-C", repositoryTree, "."]);

    await installUpdaterFromImage({
      appImage: APP_IMAGE,
      layout,
      releaseVersion: "0.41.0",
      run: runner(archive.stdout, []),
    });

    expect(readFileSync(layout.launcherPath, "utf8")).toBe(
      readFileSync(join(projectRoot, "scripts/production-deploy/launcher.sh"), "utf8"),
    );
    expect(existsSync(join(layout.controllerRoot, "v0.41.0", "self-update.sh"))).toBe(true);
  });

  it("never overwrites a deployment unit that already exists on the host", async () => {
    const { layout } = host();
    writeFileSync(join(layout.systemdDir, "osinara-deploy.timer"), "operator unit\n");

    await expect(installUpdaterFromImage({
      appImage: APP_IMAGE,
      layout,
      releaseVersion: "0.41.0",
      run: runner(imageTree(), []),
    })).rejects.toMatchObject({ code: "OSINARA_INSTALL_EXISTING_STATE" });
    expect(readFileSync(join(layout.systemdDir, "osinara-deploy.timer"), "utf8")).toBe("operator unit\n");
  });

  it("starts the minute timer and removes only the units it is given", async () => {
    const { layout } = host();
    const calls: string[] = [];
    const service = join(layout.systemdDir, "osinara-deploy.service");
    const unrelated = join(layout.systemdDir, "unrelated.service");
    writeFileSync(service, "x");
    writeFileSync(unrelated, "y");
    chmodSync(service, 0o644);
    const run = runner(Buffer.alloc(0), calls);

    await enableUpdater(run);
    await removeUpdaterUnits([service], run);

    expect(calls).toEqual([
      "systemctl enable --now osinara-deploy.timer",
      "systemctl daemon-reload",
    ]);
    expect(existsSync(service)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("lets doctor report a stopped update timer with a next step", async () => {
    const calls: string[] = [];
    const active = runner(Buffer.alloc(0), calls);
    const stopped: typeof runHostCommand = async (input) => {
      calls.push(`${input.command} ${input.args.join(" ")}`);
      throw new Error("inactive");
    };

    await expect(assertUpdaterActive(active)).resolves.toBeUndefined();
    await expect(assertUpdaterActive(stopped)).rejects.toMatchObject({
      code: "OSINARA_DOCTOR_UPDATER_INACTIVE",
      message: expect.stringContaining("systemctl enable --now osinara-deploy.timer"),
    });
    expect(calls).toEqual([
      "systemctl is-active --quiet osinara-deploy.timer",
      "systemctl is-active --quiet osinara-deploy.timer",
    ]);
  });
});
