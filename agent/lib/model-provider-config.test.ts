/**
 * Runtime model-provider configuration tests.
 *
 * Constructs covered:
 * - `parseModelProviderConfig`: validates independent agent text, vision, and voice model IDs.
 * - Required context metadata and strict object fields fail fast before provider calls.
 */
import { describe, expect, it } from "vitest";

import { parseModelProviderConfig } from "./model-provider-config.js";

const validConfig = {
  agent: {
    contextWindowTokens: 1_000_000,
    textModelId: "MiniMax-M3",
    visionModelId: "MiniMax-M3",
  },
  schemaVersion: 1,
  voice: {
    transcriptionModelId: "whisper-large-v3-turbo",
  },
};

describe("parseModelProviderConfig", () => {
  it("accepts independently selectable text, vision, and voice models", () => {
    expect(parseModelProviderConfig({
      ...validConfig,
      agent: { ...validConfig.agent, visionModelId: "vision-model" },
    })).toEqual({
      ...validConfig,
      agent: { ...validConfig.agent, visionModelId: "vision-model" },
    });
  });

  it.each([
    { ...validConfig, agent: { ...validConfig.agent, contextWindowTokens: 0 } },
    { ...validConfig, agent: { ...validConfig.agent, textModelId: "" } },
    { ...validConfig, agent: { ...validConfig.agent, unexpected: true } },
    { ...validConfig, schemaVersion: 2 },
    { ...validConfig, voice: { transcriptionModelId: "" } },
  ])("rejects invalid or ambiguous required config %#", (input) => {
    expect(() => parseModelProviderConfig(input)).toThrow(
      "AGENT_MODEL_PROVIDER_CONFIG_INVALID",
    );
  });
});
