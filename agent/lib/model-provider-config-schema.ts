/**
 * Canonical model-provider configuration schema.
 *
 * Exports:
 * - `AgentModelTransport`: supported protocol and reasoning transport union.
 * - `ModelProviderConfig`: validated provider, model, vision, and optional voice contract.
 * - `ModelProviderId`: supported direct providers.
 * - `parseModelProviderConfig`: validates decoded configuration without filesystem access.
 * - `validateModelProviderRuntimeEnvironment`: enforces config-dependent startup credentials.
 */
import { z } from "zod";

import { AppError } from "./app-error.js";
import { MODEL_PROVIDER_MAX_OUTPUT_TOKENS } from "./model-provider-limits.js";
import { getOpenCodeGoProtocol } from "./provider-catalog/opencode-go-models.js";

const modelIdSchema = z.string().trim().min(1).max(200);
const modelProviderIdSchema = z.enum(["deepseek", "minimax", "neuraldeep", "opencode-go", "openrouter"]);
const reasoningEffortSchema = z.enum(["max", "xhigh", "high", "medium", "low", "minimal"]);
const maxOutputTokensSchema = z.number().int().positive().max(MODEL_PROVIDER_MAX_OUTPUT_TOKENS);
const externalBaseUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    context.addIssue({ code: "custom", message: "HTTPS is required" });
  }
  if (url.search || url.hash || url.pathname.endsWith("/messages")) {
    context.addIssue({ code: "custom", message: "base URL must not include request details" });
  }
});

const anthropicMessagesTransportSchema = z.object({
  authentication: z.enum(["api-key", "bearer"]),
  baseUrl: externalBaseUrlSchema,
  compatibility: z.literal("minimax-anthropic").optional(),
  protocol: z.literal("anthropic-messages"),
  reasoning: z.discriminatedUnion("type", [
    z.object({ type: z.literal("none") }).strict(),
    z.object({ mode: z.literal("adaptive"), type: z.literal("enabled") }).strict(),
  ]).nullable(),
}).strict();

const openAiChatCompletionsTransportSchema = z.object({
  baseUrl: externalBaseUrlSchema,
  protocol: z.literal("openai-chat-completions"),
  providerName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  reasoning: z.discriminatedUnion("type", [
    z.object({
      format: z.enum(["deepseek", "reasoning-effort", "reasoning-object"]),
      type: z.literal("none"),
    }).strict(),
    z.object({
      effort: reasoningEffortSchema,
      format: z.enum(["deepseek", "reasoning-effort", "reasoning-object"]),
      type: z.literal("effort"),
    }).strict(),
  ]).nullable(),
}).strict();

const visionModelSchema = z.discriminatedUnion("supportsImageInput", [
  z.object({ supportsImageInput: z.literal(false) }).strict(),
  z.object({
    id: modelIdSchema,
    maxOutputTokens: maxOutputTokensSchema,
    supportsImageInput: z.literal(true),
  }).strict(),
]);

const modelProviderConfigSchema = z.object({
  agent: z.object({
    models: z.object({
      primary: z.object({
        contextWindowTokens: z.number().int().positive(),
        id: modelIdSchema,
        maxOutputTokens: maxOutputTokensSchema,
      }).strict(),
      vision: visionModelSchema,
    }).strict(),
    transport: z.discriminatedUnion("protocol", [
      anthropicMessagesTransportSchema,
      openAiChatCompletionsTransportSchema,
    ]),
  }).strict(),
  provider: modelProviderIdSchema,
  schemaVersion: z.literal(4),
  voice: z.discriminatedUnion("enabled", [
    z.object({ enabled: z.literal(false) }).strict(),
    z.object({ enabled: z.literal(true), transcriptionModelId: modelIdSchema }).strict(),
  ]),
}).strict().superRefine((config, context) => {
  const transport = config.agent.transport;
  const expectedBaseUrl = {
    deepseek: "https://api.deepseek.com",
    minimax: "https://api.minimax.io/anthropic/v1",
    neuraldeep: "https://api.neuraldeep.ru/v1",
    "opencode-go": "https://opencode.ai/zen/go/v1",
    openrouter: "https://openrouter.ai/api/v1",
  }[config.provider];
  if (transport.baseUrl !== expectedBaseUrl) {
    context.addIssue({
      code: "custom",
      message: "provider transport does not match",
      path: ["agent", "transport"],
    });
  }

  // Fixed providers cannot borrow another provider's protocol or request format.
  if (config.provider === "deepseek" && (
    transport.protocol !== "openai-chat-completions" ||
    transport.providerName !== "deepseek" ||
    transport.reasoning !== null && transport.reasoning.format !== "deepseek"
  )) context.addIssue({ code: "custom", message: "DeepSeek transport mismatch", path: ["agent", "transport"] });
  if (config.provider === "minimax" && (
    transport.protocol !== "anthropic-messages" ||
    transport.authentication !== "bearer" ||
    transport.compatibility !== "minimax-anthropic"
  )) {
    context.addIssue({ code: "custom", message: "MiniMax transport mismatch", path: ["agent", "transport"] });
  }
  if (config.provider === "neuraldeep" && (
    transport.protocol !== "openai-chat-completions" ||
    transport.providerName !== "neuraldeep" ||
    transport.reasoning !== null
  )) context.addIssue({ code: "custom", message: "NeuralDeep transport mismatch", path: ["agent", "transport"] });
  if (config.provider === "opencode-go") {
    const expectedProtocol = getOpenCodeGoProtocol(config.agent.models.primary.id);
    const anthropicMismatch = transport.protocol === "anthropic-messages" && (
      transport.authentication !== "bearer" || transport.compatibility !== undefined
    );
    const openAiMismatch = transport.protocol === "openai-chat-completions" && (
      transport.providerName !== "opencode-go" ||
      transport.reasoning !== null && transport.reasoning.format !== "reasoning-effort"
    );
    if (!expectedProtocol || transport.protocol !== expectedProtocol
      || anthropicMismatch || openAiMismatch) {
      context.addIssue({
        code: "custom",
        message: "OpenCode Go transport mismatch",
        path: ["agent", "transport"],
      });
    }
  }
  if (config.provider === "openrouter" && (
    transport.protocol !== "openai-chat-completions" ||
    transport.providerName !== "openrouter" ||
    transport.reasoning !== null && transport.reasoning.format !== "reasoning-object"
  )) context.addIssue({ code: "custom", message: "OpenRouter transport mismatch", path: ["agent", "transport"] });
});

export type AgentModelTransport = z.infer<typeof modelProviderConfigSchema>["agent"]["transport"];
export type ModelProviderConfig = z.infer<typeof modelProviderConfigSchema>;
export type ModelProviderId = z.infer<typeof modelProviderIdSchema>;

export function parseModelProviderConfig(value: unknown): ModelProviderConfig {
  const parsed = modelProviderConfigSchema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new AppError(
      "AGENT_MODEL_PROVIDER_CONFIG_INVALID",
      `Некорректная конфигурация моделей: ${fields}`,
    );
  }
  return parsed.data;
}

/** Voice is optional, but an enabled Groq route must have its own non-blank startup credential. */
export function validateModelProviderRuntimeEnvironment(
  configValue: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): { GROQ_API_KEY: string | undefined } {
  const config = parseModelProviderConfig(configValue);
  const groqApiKey = environment.GROQ_API_KEY;
  if (config.voice.enabled && (groqApiKey === undefined || groqApiKey.trim().length === 0)) {
    throw new AppError(
      "AGENT_GROQ_API_KEY_REQUIRED",
      "Для включённого распознавания голосовых сообщений задайте GROQ_API_KEY",
    );
  }
  return { GROQ_API_KEY: groqApiKey };
}
