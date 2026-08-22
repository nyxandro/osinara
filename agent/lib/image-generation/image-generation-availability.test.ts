/**
 * Subscription image generation availability tests.
 *
 * Construct covered:
 * - `supportsSubscriptionImageGeneration`: enables the feature only for CLIProxy-backed Codex.
 */
import { describe, expect, it } from "vitest";

import { supportsSubscriptionImageGeneration } from "./image-generation-availability.js";

describe("subscription image generation availability", () => {
  it("requires the Codex subscription provider", () => {
    expect(supportsSubscriptionImageGeneration("codex-subscription")).toBe(true);
    for (const provider of ["deepseek", "minimax", "neuraldeep", "opencode-go", "openrouter"] as const) {
      expect(supportsSubscriptionImageGeneration(provider)).toBe(false);
    }
  });
});
