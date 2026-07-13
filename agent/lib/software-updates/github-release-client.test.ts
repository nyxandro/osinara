/**
 * Public GitHub software release client tests.
 *
 * Constructs covered:
 * - Stable latest-release, Compose-byte hash, and deployment-manifest validation.
 * - Mutable, draft, prerelease, malformed, missing-asset, and wrong-image rejection.
 * - One bounded request per endpoint with no hidden retry.
 */
import { describe, expect, it, vi } from "vitest";

import { createGitHubSoftwareReleaseClient } from "./github-release-client.js";

const DIGEST = "a".repeat(64);

function deploymentManifest(overrides: Record<string, unknown> = {}) {
  return {
    commitSha: "b".repeat(40),
    composeSha256: "c".repeat(64),
    images: {
      app: `ghcr.io/nyxandro/osinara-app@sha256:${DIGEST}`,
      edge: `ghcr.io/nyxandro/osinara-edge@sha256:${DIGEST}`,
      sandboxEgressProxy: `ghcr.io/nyxandro/osinara-sandbox-egress-proxy@sha256:${DIGEST}`,
      sandboxRunner: `ghcr.io/nyxandro/osinara-sandbox-runner@sha256:${DIGEST}`,
      sandboxRuntime: `ghcr.io/nyxandro/osinara-sandbox-runtime@sha256:${DIGEST}`,
    },
    schemaVersion: 1,
    version: "0.2.0",
    ...overrides,
  };
}

function githubRelease(overrides: Record<string, unknown> = {}) {
  return {
    assets: [{
      browser_download_url:
        "https://github.com/nyxandro/osinara/releases/download/v0.2.0/osinara-deployment.json",
      name: "osinara-deployment.json",
      state: "uploaded",
    }],
    draft: false,
    html_url: "https://github.com/nyxandro/osinara/releases/tag/v0.2.0",
    immutable: true,
    prerelease: false,
    tag_name: "v0.2.0",
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("GitHub software release client", () => {
  it("returns a fully validated release newer than the installed package", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(githubRelease()))
      .mockResolvedValueOnce(jsonResponse(deploymentManifest()));
    const client = createGitHubSoftwareReleaseClient({ fetch: fetchMock, timeoutMs: 1_000 });

    await expect(client.latestNewerThan("0.1.0")).resolves.toMatchObject({
      manifest: {
        composeSha256: "c".repeat(64),
        schemaVersion: 1,
        version: "0.2.0",
      },
      releaseUrl: "https://github.com/nyxandro/osinara/releases/tag/v0.2.0",
      version: "0.2.0",
    });

    // Public metadata and assets must never receive an accidental credential header.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const headers = new Headers((call[1] as RequestInit | undefined)?.headers);
      expect(headers.has("authorization")).toBe(false);
      expect((call[1] as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each([
    ["mutable", { immutable: false }],
    ["draft", { draft: true }],
    ["prerelease", { prerelease: true }],
    ["non-stable tag", { tag_name: "v0.2.0-rc.1" }],
  ])("ignores a %s latest release before fetching its manifest", async (_name, override) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(githubRelease(override)));
    const client = createGitHubSoftwareReleaseClient({ fetch: fetchMock, timeoutMs: 1_000 });

    await expect(client.latestNewerThan("0.1.0")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed release metadata and does not retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ tag_name: "v0.2.0" }));
    const client = createGitHubSoftwareReleaseClient({ fetch: fetchMock, timeoutMs: 1_000 });

    await expect(client.latestNewerThan("0.1.0"))
      .rejects.toThrowError(/AGENT_SOFTWARE_RELEASE_INVALID/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires exactly one uploaded deployment manifest asset", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(githubRelease({ assets: [] })));
    const client = createGitHubSoftwareReleaseClient({ fetch: fetchMock, timeoutMs: 1_000 });

    await expect(client.latestNewerThan("0.1.0"))
      .rejects.toThrowError(/AGENT_SOFTWARE_MANIFEST_ASSET_INVALID/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a manifest with an unpinned or wrong image and does not retry", async () => {
    const invalidManifest = deploymentManifest({
      images: {
        ...deploymentManifest().images,
        app: "ghcr.io/nyxandro/osinara-app:latest",
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(githubRelease()))
      .mockResolvedValueOnce(jsonResponse(invalidManifest));
    const client = createGitHubSoftwareReleaseClient({ fetch: fetchMock, timeoutMs: 1_000 });

    await expect(client.latestNewerThan("0.1.0"))
      .rejects.toThrowError(/AGENT_SOFTWARE_MANIFEST_INVALID/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing", { composeSha256: undefined }],
    ["not a digest", { composeSha256: "sha256:invalid" }],
    ["uppercase", { composeSha256: "C".repeat(64) }],
  ])("rejects a %s compose.production.yaml byte hash", async (_name, override) => {
    const invalidManifest = deploymentManifest(override);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(githubRelease()))
      .mockResolvedValueOnce(jsonResponse(invalidManifest));
    const client = createGitHubSoftwareReleaseClient({ fetch: fetchMock, timeoutMs: 1_000 });

    await expect(client.latestNewerThan("0.1.0"))
      .rejects.toThrowError(/AGENT_SOFTWARE_MANIFEST_INVALID/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failed GitHub request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: "rate limited" }, 429));
    const client = createGitHubSoftwareReleaseClient({ fetch: fetchMock, timeoutMs: 1_000 });

    await expect(client.latestNewerThan("0.1.0"))
      .rejects.toThrowError(/AGENT_SOFTWARE_RELEASE_REQUEST_FAILED/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
