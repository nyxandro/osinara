/**
 * LLM provider registry tests.
 *
 * Constructs covered:
 * - `primaryModel`: server-configured protocol-native text route for the Eve agent loop.
 * - `visionModel`: absent when the active provider explicitly lacks image input.
 * - `voiceTranscriptionModel`: explicit Groq Whisper transcription route.
 */
import { describe, expect, it } from "vitest";

import { modelProviderConfig } from "./model-provider-config.js";
import {
  primaryModel,
  visionModel,
  voiceTranscriptionModel,
} from "./model-registry.js";

describe("model registry", () => {
  it("selects the configured protocol-native text model", () => {
    expect(modelProviderConfig.agent.transport.protocol).toBe("openai-chat-completions");
    expect(primaryModel.modelId).toBe(modelProviderConfig.agent.models.primary.id);
    expect(primaryModel.provider).toBe("cpa.chat");
  });

  it("does not construct a model that cannot accept image input", () => {
    expect(modelProviderConfig.agent.models.vision.supportsImageInput).toBe(false);
    expect(visionModel).toBeNull();
  });

  it("selects the explicit Groq Whisper model for voice transcription", () => {
    expect(voiceTranscriptionModel.modelId).toBe(
      modelProviderConfig.voice.transcriptionModelId,
    );
    expect(voiceTranscriptionModel.provider).toBe("groq.transcription");
  });
});
