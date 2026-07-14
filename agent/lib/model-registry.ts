/**
 * Explicit AI SDK provider registry.
 *
 * Exports:
 * - `primaryModel`: server-configured CLIProxy text model for the Eve agent loop.
 * - `visionModel`: independently selected CLIProxy vision model.
 * - `voiceTranscriptionModel`: server-configured Groq Whisper route for Telegram voice notes.
 *
 * Key constructs:
 * - MiniMax routes use the dedicated adapter that preserves interleaved reasoning.
 * - Other configured OpenAI-compatible upstreams retain the generic CLIProxy route.
 */
import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { AppError } from "./app-error.js";
import { createMiniMaxCliProxyModel } from "./minimax-model.js";
import { modelProviderConfig } from "./model-provider-config.js";

const CLI_PROXY_PROVIDER_NAME = "cli-proxy-api";
const MINIMAX_UPSTREAM_NAME = "minimax";

const groq = createGroq({
  apiKey: process.env.GROQ_API_KEY as string,
});

const cliProxyApi = createOpenAICompatible({
  apiKey: process.env.CLI_PROXY_API_KEY as string,
  baseURL: process.env.CLI_PROXY_BASE_URL as string,
  name: CLI_PROXY_PROVIDER_NAME,
});

function cliProxyChatModel(alias: string) {
  // Keep an explicit registry guard even though startup config validation checks aliases.
  const upstream = modelProviderConfig.agent.upstream.models.find(
    (model) => model.alias === alias,
  );
  if (!upstream) {
    throw new AppError(
      "AGENT_MODEL_ALIAS_UNKNOWN",
      `Модель «${alias}» отсутствует в конфигурации upstream-моделей`,
    );
  }
  if (modelProviderConfig.agent.upstream.name === MINIMAX_UPSTREAM_NAME) {
    return createMiniMaxCliProxyModel({
      apiKey: process.env.CLI_PROXY_API_KEY as string,
      baseURL: process.env.CLI_PROXY_BASE_URL as string,
      modelId: alias,
    });
  }
  return cliProxyApi.chatModel(alias);
}

// Text and vision selection are independent but share one explicit CLIProxy transport.
export const primaryModel = cliProxyChatModel(modelProviderConfig.agent.textModelId);
export const visionModel = cliProxyChatModel(modelProviderConfig.agent.visionModelId);

// Voice remains isolated on Groq and never falls back to the agent provider.
export const voiceTranscriptionModel = groq.transcription(
  modelProviderConfig.voice.transcriptionModelId,
);
