/**
 * Codex subscription CLIProxy runtime tests.
 *
 * Constructs covered:
 * - Entrypoint emits an authenticated, no-retry gateway over a persistent Codex OAuth store.
 * - Missing or malformed OAuth credentials fail before the proxy process starts.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const entrypoint = resolve("infra/cli-proxy-entrypoint.sh");

async function writeCodexAuth(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 });
  const authPath = join(directory, "opencode-codex.json");
  await writeFile(authPath, JSON.stringify({
    access_token: "access-token",
    account_id: "00000000-0000-4000-8000-000000000001",
    expired: "2026-08-28T05:59:46Z",
    refresh_token: "refresh-token",
    type: "codex",
  }), { mode: 0o600 });
  await chmod(authPath, 0o600);
}

describe("CLIProxy Codex subscription runtime", () => {
  it("renders an authenticated no-retry gateway over the persistent OAuth directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osinara-cli-proxy-"));
    const authDirectory = join(directory, "auth");
    const target = join(directory, "config.json");
    try {
      await writeCodexAuth(authDirectory);
      await execFileAsync("sh", [entrypoint, authDirectory, target, "/bin/true"], {
        env: {
          ...process.env,
          CLI_PROXY_API_KEY: "client-test-key",
        },
      });
      const rendered = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;

      expect(rendered).toMatchObject({
        "api-keys": ["client-test-key"],
        "auth-dir": authDirectory,
        "disable-cooling": true,
        "disable-image-generation": "chat",
        "max-retry-credentials": 1,
        "request-retry": 0,
      });
      expect(rendered).not.toHaveProperty("openai-compatibility");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("fails fast when no Codex OAuth credential is mounted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osinara-cli-proxy-"));
    const authDirectory = join(directory, "auth");
    try {
      await mkdir(authDirectory, { mode: 0o700 });
      await expect(execFileAsync("sh", [
        entrypoint,
        authDirectory,
        join(directory, "config.json"),
        "/bin/true",
      ], {
        env: {
          ...process.env,
          CLI_PROXY_API_KEY: "client-test-key",
        },
      })).rejects.toMatchObject({
        stderr: expect.stringContaining("CLI_PROXY_CODEX_AUTH_MISSING"),
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects incomplete Codex OAuth bytes without starting the proxy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osinara-cli-proxy-"));
    const authDirectory = join(directory, "auth");
    try {
      await mkdir(authDirectory, { mode: 0o700 });
      const authPath = join(authDirectory, "broken.json");
      await writeFile(authPath, JSON.stringify({ type: "codex" }), { mode: 0o600 });
      await chmod(authPath, 0o600);

      await expect(execFileAsync("sh", [
        entrypoint,
        authDirectory,
        join(directory, "config.json"),
        "/bin/true",
      ], {
        env: { ...process.env, CLI_PROXY_API_KEY: "client-test-key" },
      })).rejects.toMatchObject({
        stderr: expect.stringContaining("CLI_PROXY_CODEX_AUTH_INVALID"),
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
