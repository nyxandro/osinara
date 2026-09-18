/**
 * Installation bundle build and validation tests.
 *
 * Constructs covered:
 * - `build-installation-bundle.sh`: emits deterministic root-controller archive bytes.
 * - `validateInstallationBundle`: accepts only the exact regular-file allowlist and safe metadata.
 */
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { readInstallationBundle, validateInstallationBundle } from "./installation-bundle.js";

const buildScript = resolve("scripts/provider-installer/build-installation-bundle.sh");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("installation bundle", () => {
  it("builds deterministic bytes containing the exact root-executed allowlist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osinara-install-bundle-test-"));
    temporaryDirectories.push(directory);
    const first = join(directory, "first.tar.gz");
    const second = join(directory, "second.tar.gz");
    const manifestPath = join(directory, "osinara-deployment.json");
    const composePath = join(directory, "compose.installation.json");
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1 }));
    await writeFile(composePath, JSON.stringify({ name: "osinara-production", services: {} }));
    const firstBuild = spawnSync("bash", [buildScript, first, manifestPath, composePath], { encoding: "utf8" });
    const secondBuild = spawnSync("bash", [buildScript, second, manifestPath, composePath], { encoding: "utf8" });
    expect(firstBuild.status, firstBuild.stderr).toBe(0);
    expect(secondBuild.status, secondBuild.stderr).toBe(0);
    const firstBytes = await readFile(first);
    const secondBytes = await readFile(second);
    expect(firstBytes.equals(secondBytes)).toBe(true);
    await expect(validateInstallationBundle(firstBytes)).resolves.toBeUndefined();
    const files = await readInstallationBundle(firstBytes);
    const tlsCompose = files.get("installation/traefik-compose.yaml")!.toString("utf8");
    expect(tlsCompose).toContain("image: traefik:");
    expect(tlsCompose).toContain("      - edge-frontend\n");
    expect(tlsCompose).not.toContain("      - app-network\n");
    expect(tlsCompose).toContain("name: osinara-production-edge-frontend");
    // Per-project route files let other projects on the same host share this proxy without edits.
    expect(tlsCompose).toContain("--providers.file.directory=/etc/traefik/dynamic");
    expect(tlsCompose).toContain("/opt/osinara/tls/dynamic:/etc/traefik/dynamic:ro");
    const route = files.get("installation/traefik-osinara.yaml")!.toString("utf8");
    expect(route).toContain("url: http://edge:80");
    expect(route).toContain('Host(`{{ env "OSINARA_HOSTNAME" }}`)');
  });

  it("rejects an archive containing a symbolic link", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osinara-install-bundle-test-"));
    temporaryDirectories.push(directory);
    const archive = join(directory, "malicious.tar.gz");
    await symlink("/etc/passwd", join(directory, "production-deploy.sh"));
    const result = spawnSync("tar", [
      "--create",
      "--gzip",
      "--file",
      archive,
      "--directory",
      directory,
      "--transform=s|^|installation/|",
      "production-deploy.sh",
    ], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);

    await expect(validateInstallationBundle(await readFile(archive))).rejects.toMatchObject({
      code: "OSINARA_INSTALL_BUNDLE_ENTRY_INVALID",
    });
  });
});
