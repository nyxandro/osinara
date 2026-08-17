/**
 * Installer-ready model-provider configuration builder.
 *
 * Exports:
 * - `buildModelProviderConfig`: converts one selected catalog model into validated schema v4.
 *
 * Key constructs:
 * - Canonical structural reasoning comparison independent of object identity and key order.
 * - Provider-specific endpoint, protocol, authentication, compatibility, and reasoning mapping.
 * - Fail-fast validation of model limits and required agent capabilities.
 */
import {
  parseModelProviderConfig,
  type AgentModelTransport,
  type ModelProviderConfig,
} from "../model-provider-config-schema.js";
import { AppError } from "../app-error.js";
import { MODEL_PROVIDER_MAX_OUTPUT_TOKENS } from "../model-provider-limits.js";
import type {
  ProviderCatalogModel,
  ProviderId,
  ProviderProtocol,
  ReasoningSelection,
} from "./provider-catalog-types.js";

const VOICE_TRANSCRIPTION_MODEL_ID = "whisper-large-v3-turbo";
const REASONING_EFFORTS = new Set([
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
]);

/** Validates and serializes the closed reasoning union into one canonical comparison key. */
function canonicalReasoning(selection: ReasoningSelection): string {
  if (typeof selection !== "object" || selection === null || !("type" in selection)) {
    throw new AppError(
      "AGENT_PROVIDER_CONFIG_REASONING_INVALID",
      "Выбран некорректный вариант рассуждений для модели",
    );
  }
  const keys = Object.keys(selection);
  if (selection.type === "none" && keys.length === 1) return "none";
  if (
    selection.type === "effort" &&
    keys.length === 2 &&
    REASONING_EFFORTS.has(selection.effort)
  ) {
    return `effort:${selection.effort}`;
  }
  if (
    selection.type === "enabled" &&
    keys.length === 2 &&
    (selection.mode === "adaptive" || selection.mode === "enabled")
  ) {
    return `enabled:${selection.mode}`;
  }
  throw new AppError(
    "AGENT_PROVIDER_CONFIG_REASONING_INVALID",
    "Выбран некорректный вариант рассуждений для модели",
  );
}

/** Catalog output is an integration input, so required installer fields are checked at runtime. */
function validateInstallerReadyModel(model: ProviderCatalogModel): void {
  const validContext = Number.isInteger(model.contextWindowTokens)
    && model.contextWindowTokens !== null
    && model.contextWindowTokens > 0;
  const validOutput = Number.isInteger(model.maxOutputTokens)
    && model.maxOutputTokens !== null
    && model.maxOutputTokens > 0
    && model.maxOutputTokens <= MODEL_PROVIDER_MAX_OUTPUT_TOKENS;
  const validId = typeof model.id === "string"
    && model.id.trim().length > 0
    && model.id.length <= 200;
  const validCapabilities = model.supportsTools === true
    && typeof model.supportsImageInput === "boolean";
  if (!validContext || !validOutput || !validId || !validCapabilities) {
    throw new AppError(
      "AGENT_PROVIDER_CONFIG_MODEL_INVALID",
      "Выбранная модель не содержит обязательные лимиты или возможности для установки",
    );
  }

  // Every catalog option must be structurally valid before membership can be trusted.
  if (!Array.isArray(model.reasoningOptions)) {
    throw new AppError(
      "AGENT_PROVIDER_CONFIG_MODEL_INVALID",
      "Выбранная модель содержит некорректный список вариантов рассуждений",
    );
  }
  for (const option of model.reasoningOptions) canonicalReasoning(option);
}

/** Fixed providers reject contradictory catalog protocol metadata; OpenCode Go is model-specific. */
function requireProviderProtocol(
  providerId: ProviderId,
  modelProtocol: ProviderProtocol,
): ProviderProtocol {
  const expected = providerId === "minimax"
    ? "anthropic-messages"
    : providerId === "opencode-go"
      ? modelProtocol
      : "openai-chat-completions";
  if (modelProtocol !== expected) {
    throw new AppError(
      "AGENT_PROVIDER_CONFIG_PROTOCOL_INVALID",
      `Протокол модели не соответствует поставщику ${providerId}`,
    );
  }
  return expected;
}

/** Null means the catalog exposes no control; the provider keeps its documented model behavior. */
function requireReasoningSelection(
  model: ProviderCatalogModel,
  selected: ReasoningSelection | null,
): ReasoningSelection | null {
  if (selected === null && model.reasoningOptions.length === 0) return null;
  if (selected === null) {
    throw new AppError(
      "AGENT_PROVIDER_CONFIG_REASONING_NOT_AVAILABLE",
      "Для выбранной модели необходимо выбрать доступный вариант рассуждений",
    );
  }
  const selectedKey = canonicalReasoning(selected);
  const available = model.reasoningOptions.some(
    (option) => canonicalReasoning(option) === selectedKey,
  );
  if (!available) {
    throw new AppError(
      "AGENT_PROVIDER_CONFIG_REASONING_NOT_AVAILABLE",
      "Выбранный вариант рассуждений недоступен для этой модели",
    );
  }
  return selected;
}

/** Anthropic schema supports disabled or adaptive thinking, while OpenAI transports use effort. */
function anthropicReasoning(
  reasoning: ReasoningSelection | null,
): Extract<AgentModelTransport, { protocol: "anthropic-messages" }>['reasoning'] {
  if (reasoning === null) return null;
  if (reasoning.type === "none") return { type: "none" };
  if (reasoning.type === "enabled" && reasoning.mode === "adaptive") {
    return { mode: "adaptive", type: "enabled" };
  }
  throw new AppError(
    "AGENT_PROVIDER_CONFIG_REASONING_UNSUPPORTED",
    "Выбранный вариант рассуждений не поддерживается протоколом Anthropic",
  );
}

function openAiReasoning(
  reasoning: ReasoningSelection | null,
  format: "deepseek" | "reasoning-effort" | "reasoning-object",
): Extract<AgentModelTransport, { protocol: "openai-chat-completions" }>['reasoning'] {
  if (reasoning === null) return null;
  if (reasoning.type === "none") return { format, type: "none" };
  if (reasoning.type === "effort") return { effort: reasoning.effort, format, type: "effort" };
  throw new AppError(
    "AGENT_PROVIDER_CONFIG_REASONING_UNSUPPORTED",
    "Выбранный вариант рассуждений не поддерживается протоколом OpenAI",
  );
}

/** Builds only transports accepted by the canonical schema v4 contract. */
function buildTransport(
  providerId: ProviderId,
  protocol: ProviderProtocol,
  reasoning: ReasoningSelection | null,
): AgentModelTransport {
  if (providerId === "minimax") {
    return {
      authentication: "bearer",
      baseUrl: "https://api.minimax.io/anthropic/v1",
      compatibility: "minimax-anthropic",
      protocol: "anthropic-messages",
      reasoning: anthropicReasoning(reasoning),
    };
  }
  if (providerId === "opencode-go" && protocol === "anthropic-messages") {
    return {
      authentication: "bearer",
      baseUrl: "https://opencode.ai/zen/go/v1",
      protocol: "anthropic-messages",
      reasoning: anthropicReasoning(reasoning),
    };
  }

  const openAi = {
    deepseek: {
      baseUrl: "https://api.deepseek.com",
      format: "deepseek",
      providerName: "deepseek",
    },
    neuraldeep: {
      baseUrl: "https://api.neuraldeep.ru/v1",
      format: "reasoning-effort",
      providerName: "neuraldeep",
    },
    "opencode-go": {
      baseUrl: "https://opencode.ai/zen/go/v1",
      format: "reasoning-effort",
      providerName: "opencode-go",
    },
    openrouter: {
      baseUrl: "https://openrouter.ai/api/v1",
      format: "reasoning-object",
      providerName: "openrouter",
    },
  } as const;
  const settings = openAi[providerId as keyof typeof openAi];
  return {
    baseUrl: settings.baseUrl,
    protocol: "openai-chat-completions",
    providerName: settings.providerName,
    reasoning: openAiReasoning(reasoning, settings.format),
  };
}

/** Converts catalog metadata to schema v4 and proves the result with the canonical parser. */
export function buildModelProviderConfig(
  providerId: ProviderId,
  model: ProviderCatalogModel,
  reasoning: ReasoningSelection | null,
  voiceEnabled: boolean,
): ModelProviderConfig {
  validateInstallerReadyModel(model);
  const protocol = requireProviderProtocol(providerId, model.protocol);
  const selectedReasoning = requireReasoningSelection(model, reasoning);
  const primary = {
    contextWindowTokens: model.contextWindowTokens as number,
    id: model.id,
    maxOutputTokens: model.maxOutputTokens as number,
  };

  // Vision intentionally reuses the selected primary model; no second implicit model is invented.
  const config = {
    agent: {
      models: {
        primary,
        vision: model.supportsImageInput
          ? {
              id: model.id,
              maxOutputTokens: model.maxOutputTokens as number,
              supportsImageInput: true as const,
            }
          : { supportsImageInput: false as const },
      },
      transport: buildTransport(providerId, protocol, selectedReasoning),
    },
    provider: providerId,
    schemaVersion: 4 as const,
    voice: voiceEnabled
      ? { enabled: true as const, transcriptionModelId: VOICE_TRANSCRIPTION_MODEL_ID }
      : { enabled: false as const },
  };
  return parseModelProviderConfig(config);
}
