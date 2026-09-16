/**
 * Production host contract parser tests.
 *
 * Constructs covered:
 * - `releaseEnvironmentFromManifest`: validates schema-v1 image digests and exact release version.
 * - `parseBootstrapProcessOutput`: accepts only the machine-readable one-time code contract.
 * - `buildTlsEnvironment` / `parseTlsEnvironment`: exact TLS env file round trip and fail-closed parsing.
 */
import { describe, expect, it } from "vitest";

import {
  buildTlsEnvironment,
  parseBootstrapProcessOutput,
  parseTlsEnvironment,
  releaseEnvironmentFromManifest,
  renderTraefikRoute,
} from "./host-contracts.js";

const digest = (name: string, character: string): string =>
  `ghcr.io/nyxandro/${name}@sha256:${character.repeat(64)}`;

function manifest(): Buffer {
  return Buffer.from(JSON.stringify({
    commitSha: "1".repeat(40),
    composeSha256: "2".repeat(64),
    images: {
      app: digest("osinara-app", "a"),
      cliProxy: digest("osinara-cli-proxy", "b"),
      edge: digest("osinara-edge", "c"),
      sandboxEgressProxy: digest("osinara-sandbox-egress-proxy", "d"),
      sandboxRunner: digest("osinara-sandbox-runner", "e"),
      sandboxRuntime: digest("osinara-sandbox-runtime", "f"),
    },
    schemaVersion: 1,
    version: "0.15.3",
  }));
}

describe("production host contracts", () => {
  it("emits only the five direct-provider image references used by fresh installation", () => {
    const environment = releaseEnvironmentFromManifest(manifest(), "0.15.3").toString("utf8");

    expect(environment).toContain(`OSINARA_APP_IMAGE=${digest("osinara-app", "a")}\n`);
    expect(environment).toContain(`OSINARA_EDGE_IMAGE=${digest("osinara-edge", "c")}\n`);
    expect(environment).not.toContain("OSINARA_CLI_PROXY_IMAGE");
  });

  it("rejects a manifest from another release", () => {
    expect(() => releaseEnvironmentFromManifest(manifest(), "0.15.4")).toThrow(
      "OSINARA_INSTALL_MANIFEST_INVALID",
    );
  });

  it("parses the exact bootstrap command JSON", () => {
    expect(parseBootstrapProcessOutput(Buffer.from(JSON.stringify({
      bootstrapCode: "bootstrap_secret-123",
      bootstrapExpiresAt: "2026-08-13T12:15:00.000Z",
    })))).toEqual({
      bootstrapCode: "bootstrap_secret-123",
      bootstrapExpiresAt: "2026-08-13T12:15:00.000Z",
    });
  });

  it("rejects extra bootstrap fields", () => {
    expect(() => parseBootstrapProcessOutput(Buffer.from(JSON.stringify({
      bootstrapCode: "bootstrap_secret-123",
      bootstrapExpiresAt: "2026-08-13T12:15:00.000Z",
      leaked: "unexpected",
    })))).toThrow("OSINARA_INSTALL_BOOTSTRAP_OUTPUT_INVALID");
  });
});

describe("tls environment contract", () => {
  it("round-trips hostname and mode through the exact two-line file", () => {
    const bytes = buildTlsEnvironment({ hostname: "bot.example.com", mode: "external" });

    expect(bytes.toString("utf8")).toBe("OSINARA_HOSTNAME=bot.example.com\nOSINARA_TLS_MODE=external\n");
    expect(parseTlsEnvironment(bytes)).toEqual({ hostname: "bot.example.com", mode: "external" });
  });

  it("rejects a legacy file without a mode instead of assuming managed Traefik", () => {
    expect(() => parseTlsEnvironment(Buffer.from("OSINARA_HOSTNAME=bot.example.com\n")))
      .toThrowError(expect.objectContaining({ code: "OSINARA_OPERATION_TLS_ENV_INVALID" }));
  });

  it.each(["OSINARA_HOSTNAME=bot.example.com\nOSINARA_TLS_MODE=caddy\n", "OSINARA_TLS_MODE=managed\n"])(
    "rejects an unknown mode or a missing hostname: %#",
    (text) => {
      expect(() => parseTlsEnvironment(Buffer.from(text)))
        .toThrowError(expect.objectContaining({ code: "OSINARA_OPERATION_TLS_ENV_INVALID" }));
    },
  );

  it.each([
    "OSINARA_HOSTNAME=a.example.com\nOSINARA_HOSTNAME=b.example.com\nOSINARA_TLS_MODE=managed\n",
    "OSINARA_HOSTNAME=a.example.com\nOSINARA_TLS_MODE=managed\nEXTRA=1\n",
    "OSINARA_HOSTNAME=a.example.com\nOSINARA_TLS_MODE=managed\n\n\n",
  ])("rejects duplicates, unknown entries and stray lines: %#", (text) => {
    expect(() => parseTlsEnvironment(Buffer.from(text)))
      .toThrowError(expect.objectContaining({ code: "OSINARA_OPERATION_TLS_ENV_INVALID" }));
  });

  it("accepts the two lines in either order", () => {
    expect(parseTlsEnvironment(Buffer.from("OSINARA_TLS_MODE=managed\nOSINARA_HOSTNAME=a.example.com\n")))
      .toEqual({ hostname: "a.example.com", mode: "managed" });
  });

  it("enforces DNS label and total length limits", () => {
    const longLabel = `${"a".repeat(64)}.example.com`;
    const longName = `${Array.from({ length: 5 }, () => "b".repeat(50)).join(".")}.example.com`;
    for (const hostname of [longLabel, longName]) {
      expect(() => buildTlsEnvironment({ hostname, mode: "managed" }))
        .toThrowError(expect.objectContaining({ code: "OSINARA_INSTALL_TLS_ENV_INVALID" }));
    }
    expect(() => buildTlsEnvironment({ hostname: `${"a".repeat(63)}.example.com`, mode: "managed" })).not.toThrow();
  });

  it("renders the bundled Traefik route with the installed hostname", () => {
    const template = Buffer.from('rule: \'Host(`{{ env "OSINARA_HOSTNAME" }}`)\'\n');

    expect(renderTraefikRoute(template, "bot.example.com").toString("utf8")).toBe("rule: 'Host(`bot.example.com`)'\n");
    expect(() => renderTraefikRoute(Buffer.from("rule: 'Host(`x`)'\n"), "bot.example.com"))
      .toThrowError(expect.objectContaining({ code: "OSINARA_INSTALL_BUNDLE_ENTRY_INVALID" }));
  });

  it("refuses to build a file from an unsafe hostname", () => {
    expect(() => buildTlsEnvironment({ hostname: "bad host\nOSINARA_TLS_MODE=external", mode: "managed" }))
      .toThrowError(expect.objectContaining({ code: "OSINARA_INSTALL_TLS_ENV_INVALID" }));
  });
});
