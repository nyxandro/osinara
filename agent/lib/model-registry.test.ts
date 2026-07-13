/**
 * LLM provider registry tests.
 *
 * Constructs covered:
 * - `primaryModel`: production Groq GPT-OSS 120B route for the Eve agent loop.
 * - `visionModel`: Groq Qwen route with explicit vision sampling defaults.
 * - `availableModels`: retained named routes without implicit fallback behavior.
 * - `voiceTranscriptionModel`: explicit Groq Whisper transcription route.
 */
import { describe, expect, it } from "vitest";

import {
  CLI_PROXY_MODEL_ROUTE,
  GROQ_GPT_OSS_MODEL_ROUTE,
  GROQ_QWEN_MODEL_ROUTE,
  GROQ_QWEN_TEMPERATURE,
  GROQ_TRANSCRIPTION_MODEL_ID,
  PRIMARY_MODEL_ROUTE,
  VISION_MODEL_ROUTE,
} from "../config.js";
import {
  availableModels,
  primaryModel,
  visionModel,
  voiceTranscriptionModel,
} from "./model-registry.js";

describe("model registry", () => {
  it("selects production Groq GPT-OSS 120B as the explicit primary route", () => {
    expect(PRIMARY_MODEL_ROUTE).toBe(GROQ_GPT_OSS_MODEL_ROUTE);
    expect(primaryModel).toBe(availableModels[GROQ_GPT_OSS_MODEL_ROUTE]);
    expect(primaryModel.modelId).toBe("openai/gpt-oss-120b");
  });

  it("keeps Qwen at temperature 0.6 on the explicit vision route", () => {
    expect(VISION_MODEL_ROUTE).toBe(GROQ_QWEN_MODEL_ROUTE);
    expect(GROQ_QWEN_TEMPERATURE).toBe(0.6);
    expect(visionModel).toBe(availableModels[GROQ_QWEN_MODEL_ROUTE]);
    expect(visionModel.modelId).toBe("qwen/qwen3.6-27b");
  });

  it("retains the CLIProxy GPT-5.5 route without selecting it as fallback", () => {
    expect(availableModels[CLI_PROXY_MODEL_ROUTE].modelId).toBe("gpt-5.5");
    expect(CLI_PROXY_MODEL_ROUTE).not.toBe(PRIMARY_MODEL_ROUTE);
  });

  it("selects the explicit Groq Whisper model for voice transcription", () => {
    expect(voiceTranscriptionModel.modelId).toBe(GROQ_TRANSCRIPTION_MODEL_ID);
    expect(voiceTranscriptionModel.provider).toBe("groq.transcription");
  });
});
