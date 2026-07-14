/**
 * LLM provider registry tests.
 *
 * Constructs covered:
 * - `primaryModel`: server-configured CLIProxy text route for the Eve agent loop.
 * - `visionModel`: independently configured CLIProxy route for workspace images.
 * - `voiceTranscriptionModel`: explicit Groq Whisper transcription route.
 * - MiniMax chat models keep their CLIProxy identity after contract wrapping.
 */
import { describe, expect, it } from "vitest";

import { modelProviderConfig } from "./model-provider-config.js";
import {
  primaryModel,
  visionModel,
  voiceTranscriptionModel,
} from "./model-registry.js";

describe("model registry", () => {
  it("selects the configured CLIProxy text model", () => {
    expect(modelProviderConfig.agent.upstream.name).toBe("minimax");
    expect(primaryModel.modelId).toBe(modelProviderConfig.agent.textModelId);
    expect(primaryModel.provider).toBe("cli-proxy-api.chat");
  });

  it("selects the independently configured CLIProxy vision model", () => {
    expect(visionModel.modelId).toBe(modelProviderConfig.agent.visionModelId);
    expect(visionModel.provider).toBe("cli-proxy-api.chat");
  });

  it("selects the explicit Groq Whisper model for voice transcription", () => {
    expect(voiceTranscriptionModel.modelId).toBe(
      modelProviderConfig.voice.transcriptionModelId,
    );
    expect(voiceTranscriptionModel.provider).toBe("groq.transcription");
  });
});
