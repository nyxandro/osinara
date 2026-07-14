/**
 * Internal CLIProxyAPI runtime contract tests.
 *
 * Constructs covered:
 * - Runtime config rendering keeps client and upstream secrets out of source configuration.
 * - NeuralDeep-compatible models are exposed without retries or a management surface.
 * - Docker wiring keeps CLIProxyAPI internal and pins its canonical release image.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = new URL("./", import.meta.url).pathname;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("CLIProxyAPI runtime", () => {
  it("renders authenticated no-retry upstream config from server models and environment secrets", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-cli-proxy-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "config.json");
    const result = spawnSync(
      "/bin/sh",
      [
        join(projectRoot, "infra/cli-proxy-entrypoint.sh"),
        join(projectRoot, "config/model-providers.json"),
        target,
        "/bin/true",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLI_PROXY_API_KEY: "client-test-key",
          MODEL_UPSTREAM_API_KEY: "upstream-test-key",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(target, "utf8"))).toMatchObject({
      "api-keys": ["client-test-key"],
      "disable-cooling": true,
      "max-retry-credentials": 1,
      "openai-compatibility": [
        {
          "api-key-entries": [{ "api-key": "upstream-test-key" }],
          "base-url": "https://api.neuraldeep.ru/v1",
          models: [{ alias: "qwen3.6-fp8", name: "qwen3.6-fp8" }],
          name: "neuraldeep",
        },
      ],
      "remote-management": {
        "allow-remote": false,
        "disable-control-panel": true,
        "secret-key": "",
      },
      "request-retry": 0,
    });
  });

  it("fails before startup when either required secret is absent", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-cli-proxy-"));
    temporaryDirectories.push(directory);
    const result = spawnSync(
      "/bin/sh",
      [
        join(projectRoot, "infra/cli-proxy-entrypoint.sh"),
        join(projectRoot, "config/model-providers.json"),
        join(directory, "config.json"),
        "/bin/true",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLI_PROXY_API_KEY: "client-test-key",
          MODEL_UPSTREAM_API_KEY: "",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CLI_PROXY_REQUIRED_CONFIG_MISSING");
    expect(result.stderr).not.toContain("client-test-key");
  });

  it("ships a pinned internal-only CLIProxyAPI service", () => {
    const dockerfile = readFileSync(join(projectRoot, "Dockerfile"), "utf8");
    const compose = readFileSync(
      join(projectRoot, "compose.production.yaml"),
      "utf8",
    );
    const serviceStart = compose.indexOf("\n  cli-proxy-api:\n");
    const serviceEnd = compose.indexOf("\n  agent:\n", serviceStart);
    const service = compose.slice(serviceStart, serviceEnd);

    expect(dockerfile).toContain(
      "eceasy/cli-proxy-api@sha256:0b27437917e45a22612ff43ede0fd6baf077c1898c622037a24a79399a9b3d0c AS cli-proxy",
    );
    expect(service).toContain("OSINARA_CLI_PROXY_IMAGE");
    expect(service).toContain("MODEL_UPSTREAM_API_KEY");
    expect(service).toContain("- app-network");
    expect(service).not.toContain("ports:");
  });
});
