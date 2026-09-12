/**
 * Explicit AI SDK model registry.
 *
 * Exports:
 * - `primaryModel`: configured protocol-native text model for the Eve agent loop.
 * - `visionModel`: independently selected model, or `null` when image input is unsupported.
 * - `voiceTranscriptionModel`: isolated Groq Whisper route for Telegram voice notes.
 */
import { createGroq } from "@ai-sdk/groq";

import { modelProviderConfig } from "./model-provider-config.js";
import { createConfiguredLanguageModel } from "./model-transport.js";
import { recordSuccessfulModelCall } from "./model-availability-repository.js";

const agentModelApiKey = process.env.MODEL_API_KEY as string;
const groqApiKey = process.env.GROQ_API_KEY;

export const primaryModel = createConfiguredLanguageModel({
  onSuccessfulCall: recordSuccessfulModelCall,
  apiKey: agentModelApiKey,
  maxOutputTokens: modelProviderConfig.agent.models.primary.maxOutputTokens,
  modelId: modelProviderConfig.agent.models.primary.id,
  transport: modelProviderConfig.agent.transport,
});
const visionConfig = modelProviderConfig.agent.models.vision;
export const visionModel = visionConfig.supportsImageInput
  ? createConfiguredLanguageModel({
      onSuccessfulCall: recordSuccessfulModelCall,
      apiKey: agentModelApiKey,
      maxOutputTokens: visionConfig.maxOutputTokens,
      modelId: visionConfig.id,
      transport: modelProviderConfig.agent.transport,
    })
  : null;

// Voice is an explicit optional capability and never falls back to the agent transport.
export const voiceTranscriptionModel = modelProviderConfig.voice.enabled && groqApiKey
  ? createGroq({ apiKey: groqApiKey }).transcription(
      modelProviderConfig.voice.transcriptionModelId,
    )
  : null;
