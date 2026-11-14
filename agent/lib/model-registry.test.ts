/**
 * LLM provider registry tests.
 *
 * Constructs covered:
 * - `primaryModel`: server-configured protocol-native text route for the agent loop.
 * - `visionModel`: absent when the active provider explicitly lacks image input.
 * - `voiceTranscriptionModel`: explicit Groq Whisper transcription route.
 * - A malformed `MODEL_PROXY_URL` stops the registry from loading at all.
 */
import { describe, expect, it, vi } from "vitest";

import { modelProviderConfig } from "./model-provider-config.js";
import { primaryModel, visionModel, voiceTranscriptionModel } from "./model-registry.js";

describe("model registry", () => {
  it("selects the configured protocol-native text model", () => {
    expect(modelProviderConfig.agent.transport.protocol).toBe("openai-chat-completions");
    expect(primaryModel.modelId).toBe(modelProviderConfig.agent.models.primary.id);
    expect(primaryModel.provider).toBe("deepseek.chat");
  });

  it("does not construct a model that cannot accept image input", () => {
    expect(modelProviderConfig.agent.models.vision.supportsImageInput).toBe(false);
    expect(visionModel).toBeNull();
  });

  it("constructs voice transcription only when both config and credential enable it", () => {
    if (!process.env.GROQ_API_KEY || !modelProviderConfig.voice.enabled) {
      expect(voiceTranscriptionModel).toBeNull();
      return;
    }
    expect(voiceTranscriptionModel?.modelId).toBe(modelProviderConfig.voice.transcriptionModelId);
    expect(voiceTranscriptionModel?.provider).toBe("groq.transcription");
  });

  it("refuses to load with a malformed model proxy instead of calling the provider directly", async () => {
    vi.resetModules();
    vi.stubEnv("MODEL_PROXY_URL", "172.17.0.1:10810");
    try {
      await expect(import("./model-registry.js")).rejects.toMatchObject({
        code: "AGENT_MODEL_PROXY_URL_INVALID",
      });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
