/**
 * Explicit AI SDK provider registry.
 *
 * Exports:
 * - `primaryModel`: server-configured CLIProxy text model for the Eve agent loop.
 * - `visionModel`: independently selected CLIProxy vision model.
 * - `voiceTranscriptionModel`: server-configured Groq Whisper route for Telegram voice notes.
 */
import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { modelProviderConfig } from "./model-provider-config.js";

const groq = createGroq({
  apiKey: process.env.GROQ_API_KEY as string,
});

const cliProxyApi = createOpenAICompatible({
  apiKey: process.env.CLI_PROXY_API_KEY as string,
  baseURL: process.env.CLI_PROXY_BASE_URL as string,
  name: "cli-proxy-api",
});

// Text and vision selection are independent but share one explicit CLIProxy transport.
export const primaryModel = cliProxyApi.chatModel(modelProviderConfig.agent.textModelId);
export const visionModel = cliProxyApi.chatModel(modelProviderConfig.agent.visionModelId);

// Voice remains isolated on Groq and never falls back to the agent provider.
export const voiceTranscriptionModel = groq.transcription(
  modelProviderConfig.voice.transcriptionModelId,
);
