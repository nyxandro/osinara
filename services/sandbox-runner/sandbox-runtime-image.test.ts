/**
 * Required sandbox runtime image configuration tests.
 *
 * Constructs covered:
 * - `resolveSandboxRuntimeImage` rejects absent image identity with a stable error.
 * - The exact digest or local development image reference is passed through unchanged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveSandboxDockerRuntime,
  resolveSandboxRuntimeImage,
} from "./docker-sandbox-engine.js";

const originalImage = process.env.SANDBOX_RUNTIME_IMAGE;

afterEach(() => {
  if (originalImage === undefined) delete process.env.SANDBOX_RUNTIME_IMAGE;
  else process.env.SANDBOX_RUNTIME_IMAGE = originalImage;
});

describe("resolveSandboxRuntimeImage", () => {
  it("fails fast when SANDBOX_RUNTIME_IMAGE is absent", () => {
    delete process.env.SANDBOX_RUNTIME_IMAGE;

    expect(() => resolveSandboxRuntimeImage()).toThrowError(
      "AGENT_SANDBOX_RUNTIME_IMAGE_MISSING: Не задан обязательный образ sandbox runtime",
    );
  });

  it("returns the exact configured image reference", () => {
    const image =
      "ghcr.io/nyxandro/osinara-sandbox-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    process.env.SANDBOX_RUNTIME_IMAGE = image;

    expect(resolveSandboxRuntimeImage()).toBe(image);
  });

  it("rejects missing configuration before contacting Docker", async () => {
    delete process.env.SANDBOX_RUNTIME_IMAGE;
    const inspect = vi.fn();
    const docker = { getContainer: vi.fn(() => ({ inspect })) };

    await expect(resolveSandboxDockerRuntime(docker as never)).rejects.toThrowError(
      /AGENT_SANDBOX_RUNTIME_IMAGE_MISSING/,
    );
    expect(docker.getContainer).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });
});
