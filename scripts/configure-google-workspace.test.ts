/**
 * Google Workspace environment importer tests.
 *
 * Constructs covered:
 * - Web OAuth JSON must contain every required callback URI.
 * - Environment updates preserve unrelated values and existing encryption keys.
 * - First-time setup generates and validates a new 32-byte encryption key.
 * - A second environment receives the OAuth client but never reuses the encryption key.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildGoogleWorkspaceEnvironment,
  parseGoogleOAuthClient,
  readGoogleWorkspaceCredentials,
  syncGoogleWorkspaceEnvironment,
} from "./configure-google-workspace.js";

const localCallback =
  "https://desktop-ukevcbh.tail245bf9.ts.net/eve/v1/google-oauth/callback";
const productionCallback =
  "https://sbe720bcf.fastvps-server.com/eve/v1/google-oauth/callback";

function clientJson(redirectUris = [localCallback, productionCallback]) {
  return JSON.stringify({
    web: {
      client_id: "client-id.apps.googleusercontent.com",
      client_secret: "client-secret",
      project_id: "nyxandro",
      redirect_uris: redirectUris,
    },
  });
}

describe("Google Workspace configuration importer", () => {
  it("accepts only a web client containing all required callbacks", () => {
    expect(parseGoogleOAuthClient(clientJson(), [localCallback, productionCallback])).toEqual({
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "client-secret",
      projectId: "nyxandro",
      redirectUris: [localCallback, productionCallback],
    });
    expect(() => parseGoogleOAuthClient(
      JSON.stringify({ installed: JSON.parse(clientJson()).web }),
      [localCallback],
    )).toThrowError(/AGENT_GOOGLE_SETUP_CLIENT_INVALID/);
    expect(() => parseGoogleOAuthClient(clientJson([localCallback]), [productionCallback]))
      .toThrowError(/AGENT_GOOGLE_SETUP_REDIRECT_MISSING/);
  });

  it("preserves unrelated settings and an existing encryption key", () => {
    const existingKey = Buffer.alloc(32, 1).toString("base64");
    const generateKey = vi.fn(() => Buffer.alloc(32, 2).toString("base64"));
    const result = buildGoogleWorkspaceEnvironment([
      "TELEGRAM_BOT_TOKEN=secret",
      "GOOGLE_OAUTH_CLIENT_ID=",
      "GOOGLE_OAUTH_CLIENT_SECRET=",
      `INTEGRATION_TOKEN_ENCRYPTION_KEY=${existingKey}`,
      "PUBLIC_BASE_URL=",
      "",
    ].join("\n"), {
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "client-secret",
      publicBaseUrl: "https://agent.example",
    }, generateKey);

    expect(result.encryptionKeyGenerated).toBe(false);
    expect(generateKey).not.toHaveBeenCalled();
    expect(result.source).toContain("TELEGRAM_BOT_TOKEN=secret");
    expect(result.source).toContain("GOOGLE_OAUTH_CLIENT_ID=client-id.apps.googleusercontent.com");
    expect(result.source).toContain(`INTEGRATION_TOKEN_ENCRYPTION_KEY=${existingKey}`);
  });

  it("generates a key on first setup and rejects duplicate environment entries", () => {
    const generatedKey = Buffer.alloc(32, 3).toString("base64");
    const result = buildGoogleWorkspaceEnvironment("TELEGRAM_BOT_TOKEN=secret\n", {
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "client-secret",
      publicBaseUrl: "https://agent.example",
    }, () => generatedKey);

    expect(result.encryptionKeyGenerated).toBe(true);
    expect(result.source).toContain(`INTEGRATION_TOKEN_ENCRYPTION_KEY=${generatedKey}`);
    expect(() => buildGoogleWorkspaceEnvironment(
      "PUBLIC_BASE_URL=https://one.example\nPUBLIC_BASE_URL=https://two.example\n",
      {
        clientId: "client-id.apps.googleusercontent.com",
        clientSecret: "client-secret",
        publicBaseUrl: "https://agent.example",
      },
      () => generatedKey,
    )).toThrowError(/AGENT_GOOGLE_SETUP_ENV_DUPLICATE/);
  });

  it("reads validated credentials for a second environment without exposing the key", () => {
    expect(readGoogleWorkspaceCredentials([
      "GOOGLE_OAUTH_CLIENT_ID=client-id.apps.googleusercontent.com",
      "GOOGLE_OAUTH_CLIENT_SECRET=client-secret",
      "",
    ].join("\n"))).toEqual({
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "client-secret",
    });
    expect(() => readGoogleWorkspaceCredentials("GOOGLE_OAUTH_CLIENT_ID=client-id\n"))
      .toThrowError(/AGENT_GOOGLE_SETUP_SOURCE_INCOMPLETE/);
  });

  it("synchronizes credentials while generating an independent environment key", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "osinara-google-setup-"));
    const sourcePath = resolve(directory, "source.env");
    const targetPath = resolve(directory, "target.env");
    const sourceKey = Buffer.alloc(32, 4).toString("base64");
    try {
      await Promise.all([
        writeFile(sourcePath, [
          "GOOGLE_OAUTH_CLIENT_ID=client-id.apps.googleusercontent.com",
          "GOOGLE_OAUTH_CLIENT_SECRET=client-secret",
          `INTEGRATION_TOKEN_ENCRYPTION_KEY=${sourceKey}`,
          "PUBLIC_BASE_URL=https://source.example",
          "",
        ].join("\n"), { mode: 0o600 }),
        writeFile(targetPath, [
          "TELEGRAM_BOT_TOKEN=target-secret",
          "GOOGLE_OAUTH_CLIENT_ID=",
          "GOOGLE_OAUTH_CLIENT_SECRET=",
          "INTEGRATION_TOKEN_ENCRYPTION_KEY=",
          "PUBLIC_BASE_URL=",
          "",
        ].join("\n"), { mode: 0o600 }),
      ]);

      const result = await syncGoogleWorkspaceEnvironment({
        envFilePath: targetPath,
        publicBaseUrl: "https://target.example",
        sourceEnvFilePath: sourcePath,
      });
      const target = await readFile(targetPath, "utf8");

      expect(result.encryptionKeyGenerated).toBe(true);
      expect(target).toContain("TELEGRAM_BOT_TOKEN=target-secret");
      expect(target).toContain("GOOGLE_OAUTH_CLIENT_ID=client-id.apps.googleusercontent.com");
      expect(target).toContain("PUBLIC_BASE_URL=https://target.example");
      expect(target).not.toContain(`INTEGRATION_TOKEN_ENCRYPTION_KEY=${sourceKey}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
