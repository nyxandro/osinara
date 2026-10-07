/**
 * Deployment controller self-update tests.
 *
 * Constructs covered:
 * - `select_controller_dir`: the launcher runs only a version directory selected by `current`.
 * - `validate_controller_tree`: a release controller is top-level controller files only.
 * - `extract_release_controller`: the controller comes from the digest-bound release app image.
 * - `install_release_controller` / `select_release_controller`: a new version lands beside the
 *   running one and both entry points switch by rename.
 * - `ensure_release_controller`: an identical controller deploys on; a different one checks the
 *   host first and takes the claimed release over, once.
 * - `hand_over_to_release_controller`: the claim crosses into a fresh launcher process.
 * - `require_inherited_deploy_lock`: a resumed controller runs only under its predecessor's lock.
 * - `prune_retired_controllers`: keeps the selected and the newest previous controller.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = new URL("./", import.meta.url).pathname;
const temporaryDirectories: string[] = [];
const MODULES = `
  source scripts/production-deploy/common.sh
  source scripts/production-deploy/release.sh
  source scripts/production-deploy/self-update.sh
  log_event() { printf '%s\\n' "$1" >&2; }
  fail() { printf '%s %s\\n' "$1" "$2" >&2; return 1; }
`;
const VALID_TREE: Record<string, string> = {
  "common.sh": "#!/bin/bash\nreadonly A=1\n",
  "installation-compose.jq": ".\n",
  "launcher.sh": "#!/bin/bash\nexit 0\n",
  "main.sh": "#!/bin/bash\nmain() { :; }\n",
};

function runShell(source: string, environment: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", ["-c", `set -euo pipefail\n${source}`], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function writeTree(directory: string, files: Record<string, string>): string {
  mkdirSync(directory, { recursive: true });
  for (const [name, source] of Object.entries(files)) writeFileSync(join(directory, name), source, "utf8");
  return directory;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** A host with v1.0.0 selected and running, as the launcher leaves it. */
function installedHost(): { controllerRoot: string; launcher: string; running: string } {
  const bin = temporaryDirectory("osinara-controller-host-");
  const controllerRoot = join(bin, "controller");
  const running = writeTree(join(controllerRoot, "v1.0.0"), VALID_TREE);
  symlinkSync("v1.0.0", join(controllerRoot, "current"));
  const launcher = join(bin, "production-deploy.sh");
  writeFileSync(launcher, VALID_TREE["launcher.sh"]!, "utf8");
  return { controllerRoot, launcher, running };
}

/** Runs `ensure_release_controller` with the release image extraction replaced by `releaseTree`. */
function ensureReleaseController(
  host: ReturnType<typeof installedHost>,
  releaseTree: string,
  resumed: 0 | 1,
) {
  return runShell(`
    ${MODULES}
    docker() { [[ "$1 $2" == "pull --quiet" && "$3" == "$APP_IMAGE" ]]; }
    extract_release_controller() { cp -- ${JSON.stringify(releaseTree)}/* "$2"/; }
    hand_over_to_release_controller() { printf 'handover %s %s\\n' "$PROPOSAL_ID" "$LEASE_TOKEN"; }
    APP_IMAGE="ghcr.io/nyxandro/osinara-app@sha256:${"a".repeat(64)}"
    CONTROLLER_DIR=${JSON.stringify(host.running)}
    PROPOSAL_ID="11111111-1111-4111-8111-111111111111"
    LEASE_TOKEN="22222222-2222-4222-8222-222222222222"
    REQUESTED_VERSION="1.1.0"
    RESUMED_AFTER_SELF_UPDATE=${resumed}
    controller_root=${JSON.stringify(host.controllerRoot)}
    launcher=${JSON.stringify(host.launcher)}
    ensure_release_controller "$controller_root" "$launcher"
    printf 'staging=%s\\n' "$CONTROLLER_STAGING_DIR"
  `);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("controller launcher", () => {
  function selectController(controllerRoot: string) {
    return runShell(`
      source scripts/production-deploy/launcher.sh
      launcher_require_metadata() { [[ -e "$1" && ! -L "$1" ]] || { printf 'missing %s\\n' "$1" >&2; exit 1; }; }
      select_controller_dir ${JSON.stringify(controllerRoot)}
    `);
  }

  it("runs the version directory that current names", () => {
    const { controllerRoot } = installedHost();

    const result = selectController(controllerRoot);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(join(controllerRoot, "v1.0.0"));
  });

  it.each([
    ["an absolute target", (root: string) => join(root, "v1.0.0"), "DEPLOY_CONTROLLER_INVALID"],
    ["a path outside the controller root", () => "../v1.0.0", "DEPLOY_CONTROLLER_INVALID"],
    ["a name that is no release version", () => "latest", "DEPLOY_CONTROLLER_INVALID"],
  ])("refuses a current link with %s", (_case, target, code) => {
    const { controllerRoot } = installedHost();
    rmSync(join(controllerRoot, "current"));
    symlinkSync(target(controllerRoot), join(controllerRoot, "current"));

    const result = selectController(controllerRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(code);
  });

  it("refuses an empty main.sh that would pass every tick silently", () => {
    const { controllerRoot } = installedHost();
    writeFileSync(join(controllerRoot, "v1.0.0", "main.sh"), "");

    const result = selectController(controllerRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_CONTROLLER_INVALID");
  });

  it("refuses a host whose controller was never selected", () => {
    const { controllerRoot } = installedHost();
    rmSync(join(controllerRoot, "current"));

    const result = selectController(controllerRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_CONTROLLER_MISSING");
  });
});

describe("release controller validation", () => {
  function validate(directory: string) {
    return runShell(`${MODULES}\nvalidate_controller_tree ${JSON.stringify(directory)}`);
  }

  it("accepts top-level controller modules and filters", () => {
    const tree = writeTree(temporaryDirectory("osinara-controller-valid-"), VALID_TREE);

    const result = validate(tree);

    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["a symbolic link", (tree: string) => symlinkSync("/etc/passwd", join(tree, "linked.sh"))],
    ["a subdirectory", (tree: string) => writeTree(join(tree, "nested"), { "x.sh": "#!/bin/bash\n" })],
    ["an unexpected file name", (tree: string) => writeFileSync(join(tree, "notes.txt"), "x")],
    ["an upper-case module name", (tree: string) => writeFileSync(join(tree, "Main.sh"), "#!/bin/bash\n")],
    ["a module that is not valid shell", (tree: string) => writeFileSync(join(tree, "backup.sh"), "if then fi\n")],
    ["no main.sh", (tree: string) => rmSync(join(tree, "main.sh"))],
    ["an empty main.sh", (tree: string) => writeFileSync(join(tree, "main.sh"), "")],
    ["no launcher.sh", (tree: string) => rmSync(join(tree, "launcher.sh"))],
  ])("rejects a release controller with %s", (_case, change) => {
    const tree = writeTree(temporaryDirectory("osinara-controller-invalid-"), VALID_TREE);
    change(tree);

    const result = validate(tree);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_CONTROLLER_RELEASE_INVALID");
  });
});

describe("release controller extraction", () => {
  it("streams the controller directory out of the exact release app image", () => {
    const image = temporaryDirectory("osinara-controller-image-");
    const tree = writeTree(join(image, "app/deploy/controller"), VALID_TREE);
    const target = temporaryDirectory("osinara-controller-extracted-");

    const result = runShell(`
      ${MODULES}
      docker() {
        [[ "$*" == "run --rm --network none --entrypoint /bin/tar IMAGE@sha256:abc -c -C /app/deploy/controller ." ]] ||
          { printf 'unexpected docker %s\\n' "$*" >&2; return 2; }
        tar -c -C ${JSON.stringify(tree)} .
      }
      extract_release_controller IMAGE@sha256:abc ${JSON.stringify(target)}
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(target, "main.sh"), "utf8")).toBe(VALID_TREE["main.sh"]);
    expect(readFileSync(join(target, "installation-compose.jq"), "utf8")).toBe(".\n");
  });
});

describe("release controller installation", () => {
  it("installs the new version beside the running one and switches both entry points", () => {
    const host = installedHost();
    const candidate = writeTree(join(host.controllerRoot, ".staging.test"), {
      ...VALID_TREE,
      "launcher.sh": "#!/bin/bash\n# new launcher\n",
      "self-update.sh": "#!/bin/bash\n",
    });

    const result = runShell(`
      ${MODULES}
      install_release_controller ${JSON.stringify(candidate)} ${JSON.stringify(host.controllerRoot)} 1.1.0
      printf 'placed current=%s\\n' "$(readlink ${JSON.stringify(join(host.controllerRoot, "current"))})"
      select_release_controller ${JSON.stringify(host.controllerRoot)} ${JSON.stringify(host.launcher)} 1.1.0
    `);

    expect(result.status, result.stderr).toBe(0);
    // Placing never selects: `current` moves only in the separate switch step.
    expect(result.stdout).toContain("placed current=v1.0.0");
    const installed = join(host.controllerRoot, "v1.1.0");
    expect(readlinkSync(join(host.controllerRoot, "current"))).toBe("v1.1.0");
    expect(readFileSync(join(installed, "self-update.sh"), "utf8")).toBe("#!/bin/bash\n");
    expect(readFileSync(host.launcher, "utf8")).toBe("#!/bin/bash\n# new launcher\n");
    expect(existsSync(candidate)).toBe(false);
    expect(existsSync(host.running)).toBe(true);
    expect(mode(installed)).toBe(0o750);
    expect(mode(join(installed, "main.sh"))).toBe(0o640);
    expect(mode(host.launcher)).toBe(0o750);
  });

  it("refuses to reuse a directory a previous attempt left for the same version", () => {
    const host = installedHost();
    writeTree(join(host.controllerRoot, "v1.1.0"), VALID_TREE);
    const candidate = writeTree(join(host.controllerRoot, ".staging.test"), VALID_TREE);

    const result = runShell(`
      ${MODULES}
      install_release_controller ${JSON.stringify(candidate)} ${JSON.stringify(host.controllerRoot)} 1.1.0
    `);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_CONTROLLER_DIR_EXISTS");
    expect(readlinkSync(join(host.controllerRoot, "current"))).toBe("v1.0.0");
  });
});

describe("controller of the approved release", () => {
  it("keeps deploying with the running controller when the release carries the same one", () => {
    const host = installedHost();
    const release = writeTree(temporaryDirectory("osinara-controller-same-"), VALID_TREE);

    const result = ensureReleaseController(host, release, 0);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("handover");
    expect(result.stdout).toContain("staging=\n");
    expect(readlinkSync(join(host.controllerRoot, "current"))).toBe("v1.0.0");
    expect(existsSync(join(host.controllerRoot, "v1.1.0"))).toBe(false);
  });

  it.each([
    ["a changed module", { "common.sh": "#!/bin/bash\nreadonly A=2\n" }],
    ["an added module", { "self-update.sh": "#!/bin/bash\n" }],
    ["a changed launcher", { "launcher.sh": "#!/bin/bash\nexit 1\n" }],
  ])("hands the claimed release to the controller it carries when it has %s", (_case, change) => {
    const host = installedHost();
    const release = writeTree(temporaryDirectory("osinara-controller-new-"), { ...VALID_TREE, ...change });

    const result = ensureReleaseController(host, release, 0);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "handover 11111111-1111-4111-8111-111111111111 22222222-2222-4222-8222-222222222222",
    );
    expect(result.stderr).toContain("DEPLOY_CONTROLLER_UPDATED");
    expect(readlinkSync(join(host.controllerRoot, "current"))).toBe("v1.1.0");
  });

  it("does not update a second time once the release controller has taken over", () => {
    const host = installedHost();
    const release = writeTree(temporaryDirectory("osinara-controller-loop-"), {
      ...VALID_TREE,
      "common.sh": "#!/bin/bash\nreadonly A=3\n",
    });

    const result = ensureReleaseController(host, release, 1);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_CONTROLLER_UPDATE_LOOP");
    expect(result.stdout).not.toContain("handover");
    expect(readlinkSync(join(host.controllerRoot, "current"))).toBe("v1.0.0");
  });

  it("keeps the running controller when the release controller refuses this host", () => {
    const host = installedHost();
    const release = writeTree(temporaryDirectory("osinara-controller-refuses-"), {
      ...VALID_TREE,
      "main.sh": "#!/bin/bash\n[[ \"$1\" == --preflight ]] && { echo DEPLOY_COMMAND_MISSING >&2; exit 1; }\n",
    });

    const result = ensureReleaseController(host, release, 0);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_COMMAND_MISSING");
    expect(result.stderr).toContain("DEPLOY_CONTROLLER_PREFLIGHT_FAILED");
    expect(result.stdout).not.toContain("handover");
    expect(readlinkSync(join(host.controllerRoot, "current"))).toBe("v1.0.0");
    expect(existsSync(join(host.controllerRoot, "v1.1.0"))).toBe(false);
  });

  it("refuses a broken release controller before switching anything", () => {
    const host = installedHost();
    const release = writeTree(temporaryDirectory("osinara-controller-broken-"), {
      ...VALID_TREE,
      "release.sh": "if then fi\n",
    });

    const result = ensureReleaseController(host, release, 0);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_CONTROLLER_RELEASE_INVALID");
    expect(readlinkSync(join(host.controllerRoot, "current"))).toBe("v1.0.0");
  });
});

describe("controller handover", () => {
  it("replaces the process with the launcher and passes only the claim", () => {
    const directory = temporaryDirectory("osinara-controller-handover-");
    const launcher = join(directory, "production-deploy.sh");
    writeFileSync(launcher, "#!/bin/bash\nprintf 'launched %s\\n' \"$*\"\n", { mode: 0o750 });

    const result = runShell(`
      ${MODULES}
      PROPOSAL_ID="11111111-1111-4111-8111-111111111111"
      LEASE_TOKEN="22222222-2222-4222-8222-222222222222"
      hand_over_to_release_controller ${JSON.stringify(launcher)}
      printf 'still running\\n'
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      "launched --resume 11111111-1111-4111-8111-111111111111 22222222-2222-4222-8222-222222222222\n",
    );
  });

  it("reports a launcher that exists but cannot start instead of exiting silently", () => {
    const directory = temporaryDirectory("osinara-controller-handover-broken-");
    const launcher = join(directory, "production-deploy.sh");
    writeFileSync(launcher, "#!/nonexistent/interpreter\n", { mode: 0o750 });

    const result = runShell(`
      ${MODULES}
      PROPOSAL_ID="11111111-1111-4111-8111-111111111111"
      LEASE_TOKEN="22222222-2222-4222-8222-222222222222"
      hand_over_to_release_controller ${JSON.stringify(launcher)}
    `);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_CONTROLLER_HANDOVER_FAILED");
  });

  it("records a failed handover instead of leaving the claim behind", () => {
    const directory = temporaryDirectory("osinara-controller-handover-missing-");

    const result = runShell(`
      ${MODULES}
      PROPOSAL_ID="11111111-1111-4111-8111-111111111111"
      LEASE_TOKEN="22222222-2222-4222-8222-222222222222"
      hand_over_to_release_controller ${JSON.stringify(join(directory, "absent.sh"))}
    `);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_CONTROLLER_HANDOVER_FAILED");
  });
});

describe("resumed controller lock", () => {
  it("runs only while holding the lock its predecessor passed on descriptor 9", () => {
    const lock = join(temporaryDirectory("osinara-controller-lock-"), "deploy.lock");

    const inherited = runShell(`
      ${MODULES}
      exec 9>${JSON.stringify(lock)}
      flock -n 9
      require_inherited_deploy_lock ${JSON.stringify(lock)}
      flock -n ${JSON.stringify(lock)} true && echo "lock was free" || echo "lock held"
    `);
    const missing = runShell(`${MODULES}
require_inherited_deploy_lock ${JSON.stringify(lock)}`);
    const otherFile = runShell(`
      ${MODULES}
      exec 9>${JSON.stringify(`${lock}.other`)}
      require_inherited_deploy_lock ${JSON.stringify(lock)}
    `);

    expect(inherited.status, inherited.stderr).toBe(0);
    expect(inherited.stdout).toBe("lock held\n");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("DEPLOY_RESUME_LOCK_INVALID");
    expect(otherFile.status).toBe(1);
    expect(otherFile.stderr).toContain("DEPLOY_RESUME_LOCK_INVALID");
  });
});

describe("controller retention", () => {
  it("keeps the selected and the newest previous controller and removes the rest", () => {
    const { controllerRoot } = installedHost();
    for (const name of ["v1.2.0", "v1.9.0", "v1.10.0", ".staging.abc123"]) {
      writeTree(join(controllerRoot, name), VALID_TREE);
    }
    writeTree(join(controllerRoot, "operator-notes"), { "readme.txt": "kept" });
    rmSync(join(controllerRoot, "current"));
    symlinkSync("v1.10.0", join(controllerRoot, "current"));
    symlinkSync("v1.9.0", join(controllerRoot, ".current.tmp.4242"));
    const launcher = join(controllerRoot, "..", "production-deploy.sh");
    writeFileSync(join(controllerRoot, "..", ".production-deploy.sh.tmp.4242"), "#!/bin/bash\n");

    const result = runShell(
      `${MODULES}\nprune_retired_controllers ${JSON.stringify(controllerRoot)} ${JSON.stringify(launcher)}`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(controllerRoot, "v1.10.0"))).toBe(true);
    expect(existsSync(join(controllerRoot, "v1.9.0"))).toBe(true);
    expect(existsSync(join(controllerRoot, "v1.2.0"))).toBe(false);
    expect(existsSync(join(controllerRoot, "v1.0.0"))).toBe(false);
    expect(existsSync(join(controllerRoot, ".staging.abc123"))).toBe(false);
    expect(existsSync(join(controllerRoot, ".current.tmp.4242"))).toBe(false);
    expect(existsSync(join(controllerRoot, "..", ".production-deploy.sh.tmp.4242"))).toBe(false);
    expect(existsSync(launcher)).toBe(true);
    expect(existsSync(join(controllerRoot, "operator-notes"))).toBe(true);
  });
});
