/**
 * TLS-mode branching tests for the production operational commands.
 *
 * Constructs covered:
 * - `external` mode never touches the operator's proxy: no TLS Compose file, no TLS Compose commands.
 * - `managed` mode keeps the bundled Traefik project in doctor and restart.
 * - A legacy `tls/.env` without a mode is rejected instead of assuming one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hostCommands = vi.hoisted(() => ({
  run: vi.fn<(input: { args: string[]; command: string; timeoutMs: number }) => Promise<Buffer>>(
    async () => Buffer.from(""),
  ),
}));
const files = vi.hoisted(() => new Map<string, { content: string; mode: number }>());

vi.mock("./process-runner.js", () => ({ runHostCommand: hostCommands.run }));
vi.mock("../model-config/schema.js", () => ({
  parseModelProviderConfigBytes: () => ({ agent: { models: { primary: { id: "test-model" } } }, provider: "deepseek" }),
}));
vi.mock("node:fs/promises", () => ({
  lstat: async (path: string) => {
    const file = files.get(path);
    if (!file) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return { gid: 0, isFile: () => true, isSymbolicLink: () => false, mode: 0o100000 | file.mode, uid: 0 };
  },
  readFile: async (path: string) => {
    const file = files.get(path);
    if (!file) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return Buffer.from(file.content, "utf8");
  },
  realpath: async (path: string) => path,
}));

import { createProductionOperationalCommands } from "./production-operational-commands.js";

const TLS_COMPOSE = "/opt/osinara/tls/compose.yaml";

function installHost(input: { tlsEnv: string; tlsCompose: boolean }): void {
  files.clear();
  files.set("/opt/osinara/.env", { content: "TELEGRAM_BOT_USERNAME='Osinara_Bot'\n", mode: 0o600 });
  files.set("/opt/osinara/release.env", { content: "", mode: 0o600 });
  files.set("/opt/osinara/compose.installation.json", { content: "{}", mode: 0o644 });
  files.set("/opt/osinara/osinara-deployment.json", { content: JSON.stringify({ version: "0.24.0" }), mode: 0o644 });
  files.set("/opt/osinara/agent-model-providers.json", { content: "{}", mode: 0o644 });
  files.set("/opt/osinara/tls/.env", { content: input.tlsEnv, mode: 0o600 });
  if (input.tlsCompose) files.set(TLS_COMPOSE, { content: "services: {}\n", mode: 0o644 });
}

function tlsComposeCalls(): string[][] {
  return hostCommands.run.mock.calls
    .map(([call]) => call.args)
    .filter((args) => args.includes(TLS_COMPOSE));
}

describe("production operational commands by TLS mode", () => {
  beforeEach(() => {
    hostCommands.run.mockClear();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const response = new Response("ok", { status: 200 });
      Object.defineProperty(response, "url", { value: String(url) });
      return response;
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("restart in external mode never runs Compose against the operator's proxy", async () => {
    installHost({ tlsCompose: false, tlsEnv: "OSINARA_HOSTNAME=bot.example.com\nOSINARA_TLS_MODE=external\n" });

    await expect(createProductionOperationalCommands().restart()).resolves.toMatchObject({
      address: "https://bot.example.com",
      code: "OSINARA_RESTART_OK",
      tlsMode: "external",
    });
    expect(tlsComposeCalls()).toEqual([]);
    expect(hostCommands.run).toHaveBeenCalledTimes(1);
  });

  it("restart in managed mode recreates the bundled Traefik project after the application", async () => {
    installHost({ tlsCompose: true, tlsEnv: "OSINARA_HOSTNAME=bot.example.com\nOSINARA_TLS_MODE=managed\n" });

    await expect(createProductionOperationalCommands().restart()).resolves.toMatchObject({ tlsMode: "managed" });
    expect(tlsComposeCalls()).toHaveLength(1);
    expect(tlsComposeCalls()[0]).toEqual(expect.arrayContaining(["--env-file", "/opt/osinara/tls/.env", "up"]));
    expect(hostCommands.run.mock.calls.at(-1)?.[0]).toMatchObject({ args: expect.arrayContaining([TLS_COMPOSE]) });
  });

  it("doctor requires the TLS Compose file only in managed mode", async () => {
    installHost({ tlsCompose: false, tlsEnv: "OSINARA_HOSTNAME=bot.example.com\nOSINARA_TLS_MODE=external\n" });
    await expect(createProductionOperationalCommands().doctor()).resolves.toMatchObject({ code: "OSINARA_DOCTOR_OK" });
    expect(tlsComposeCalls()).toEqual([]);

    installHost({ tlsCompose: false, tlsEnv: "OSINARA_HOSTNAME=bot.example.com\nOSINARA_TLS_MODE=managed\n" });
    await expect(createProductionOperationalCommands().doctor()).rejects.toThrow(/ENOENT/u);
  });

  it("logs returns null TLS logs in external mode", async () => {
    installHost({ tlsCompose: false, tlsEnv: "OSINARA_HOSTNAME=bot.example.com\nOSINARA_TLS_MODE=external\n" });

    await expect(createProductionOperationalCommands().logs(20)).resolves.toEqual({
      application: "",
      code: "OSINARA_LOGS_READY",
      tls: null,
    });
    expect(tlsComposeCalls()).toEqual([]);
  });

  it("rejects a tls/.env without a mode instead of guessing", async () => {
    installHost({ tlsCompose: true, tlsEnv: "OSINARA_HOSTNAME=bot.example.com\n" });

    await expect(createProductionOperationalCommands().status()).rejects.toMatchObject({
      code: "OSINARA_OPERATION_TLS_ENV_INVALID",
    });
    expect(hostCommands.run).not.toHaveBeenCalled();
  });
});
