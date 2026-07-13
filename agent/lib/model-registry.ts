/**
 * Explicit AI SDK provider registry.
 *
 * Exports:
 * - `availableModels`: named Groq and CLIProxy routes without implicit fallback.
 * - `primaryModel`: production Groq GPT-OSS 120B route for the Eve agent loop.
 * - `visionModel`: Groq Qwen with an explicit temperature for workspace vision calls.
 * - `voiceTranscriptionModel`: explicit Groq Whisper route for Telegram voice notes.
 */
import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";

import {
  CLI_PROXY_MODEL_ID,
  CLI_PROXY_MODEL_ROUTE,
  GROQ_GPT_OSS_MODEL_ID,
  GROQ_GPT_OSS_MODEL_ROUTE,
  GROQ_QWEN_MODEL_ID,
  GROQ_QWEN_MODEL_ROUTE,
  GROQ_QWEN_TEMPERATURE,
  GROQ_TRANSCRIPTION_MODEL_ID,
  PRIMARY_MODEL_ROUTE,
  VISION_MODEL_ROUTE,
} from "../config.js";

const groq = createGroq({
  apiKey: process.env.GROQ_API_KEY as string,
});

const cliProxy = createOpenAICompatible({
  apiKey: process.env.CLI_PROXY_API_KEY as string,
  baseURL: process.env.CLI_PROXY_BASE_URL as string,
  name: "cli-proxy-api",
});

// Apply one explicit sampling policy to every Qwen call, including workspace vision analysis.
const qwenModel = wrapLanguageModel({
  middleware: defaultSettingsMiddleware({
    settings: { temperature: GROQ_QWEN_TEMPERATURE },
  }),
  model: groq(GROQ_QWEN_MODEL_ID),
});

export const availableModels = {
  [CLI_PROXY_MODEL_ROUTE]: cliProxy.chatModel(CLI_PROXY_MODEL_ID),
  [GROQ_GPT_OSS_MODEL_ROUTE]: groq(GROQ_GPT_OSS_MODEL_ID),
  [GROQ_QWEN_MODEL_ROUTE]: qwenModel,
} as const;

// Selection is explicit: an unavailable primary route fails instead of silently switching provider.
export const primaryModel = availableModels[PRIMARY_MODEL_ROUTE];

// The primary model is text-only, so workspace image analysis stays on Qwen.
export const visionModel = availableModels[VISION_MODEL_ROUTE];

export const voiceTranscriptionModel = groq.transcription(GROQ_TRANSCRIPTION_MODEL_ID);
