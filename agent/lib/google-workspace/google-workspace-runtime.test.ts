/**
 * Google Workspace production dependency wiring tests.
 *
 * Constructs covered:
 * - The exact gws version is a production dependency with locked integrity.
 * - Docker installs the verified binary into the sandbox where Bash invokes it.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const projectRoot = new URL("../../../", import.meta.url);

describe("Google Workspace runtime wiring", () => {
  it("pins gws 0.22.5 as an integrity-locked production dependency", async () => {
    const packageJson = JSON.parse(await readFile(new URL("package.json", projectRoot), "utf8"));
    const packageLock = JSON.parse(await readFile(new URL("package-lock.json", projectRoot), "utf8"));
    const locked = packageLock.packages["node_modules/@googleworkspace/cli"];

    expect(packageJson.dependencies["@googleworkspace/cli"]).toBe("0.22.5");
    expect(locked).toMatchObject({
      integrity:
        "sha512-Cej4nnkjphwRF+i7KWx4esp0p41yZ7Rv7A+P9hmFQrMStcngTASZBpeN/Lptk58oXxnSHvEcvM69S0e0y/GlvA==",
      version: "0.22.5",
    });
  });

  it("installs the verified binary and copies it into the sandbox runtime", async () => {
    const dockerfile = await readFile(new URL("Dockerfile", projectRoot), "utf8");

    expect(dockerfile).toContain([
      "RUN npm ci --ignore-scripts \\",
      "    && npm run postinstall \\",
      "    && npm run install:gws",
    ].join("\n"));
    expect(dockerfile).toContain([
      "RUN npm ci --omit=dev --ignore-scripts \\",
      "    && npm run postinstall \\",
      "    && npm run install:gws",
    ].join("\n"));
    expect(dockerfile).toContain(
      "COPY --from=production-dependencies /app/node_modules ./node_modules",
    );
    expect(dockerfile).toContain([
      "COPY --from=production-dependencies \\",
      "  /app/node_modules/@googleworkspace/cli/bin/gws \\",
      "  /usr/local/bin/gws",
    ].join("\n"));
  });
});
