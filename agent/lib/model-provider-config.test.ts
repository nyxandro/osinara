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
    contextWindowTokens: 262_144,
    textModelId: "qwen3.6-fp8",
    upstream: {
      baseUrl: "https://api.neuraldeep.ru/v1",
      models: [{
        alias: "qwen3.6-fp8",
        inputModalities: ["text", "image"],
        name: "qwen3.6-fp8",
        outputModalities: ["text"],
      }],
      name: "neuraldeep",
    },
    visionModelId: "qwen3.6-fp8",
  },
  schemaVersion: 1,
  voice: {
    transcriptionModelId: "whisper-large-v3-turbo",
  },
};

describe("parseModelProviderConfig", () => {
  it("accepts independently selectable text, vision, and voice models", () => {
    const config = {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        upstream: {
          ...validConfig.agent.upstream,
          models: [
            ...validConfig.agent.upstream.models,
            {
              alias: "vision-model",
              inputModalities: ["text", "image"],
              name: "upstream-vision-model",
              outputModalities: ["text"],
            },
          ],
        },
        visionModelId: "vision-model",
      },
    };

    expect(parseModelProviderConfig(config)).toEqual(config);
  });

  it.each([
    { ...validConfig, agent: { ...validConfig.agent, contextWindowTokens: 0 } },
    { ...validConfig, agent: { ...validConfig.agent, textModelId: "" } },
    { ...validConfig, agent: { ...validConfig.agent, textModelId: "missing-alias" } },
    {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        upstream: {
          ...validConfig.agent.upstream,
          models: [{
            ...validConfig.agent.upstream.models[0],
            inputModalities: ["text"],
          }],
        },
      },
    },
    { ...validConfig, agent: { ...validConfig.agent, unexpected: true } },
    { ...validConfig, schemaVersion: 2 },
    { ...validConfig, voice: { transcriptionModelId: "" } },
  ])("rejects invalid or ambiguous required config %#", (input) => {
    expect(() => parseModelProviderConfig(input)).toThrow(
      "AGENT_MODEL_PROVIDER_CONFIG_INVALID",
    );
  });
});
