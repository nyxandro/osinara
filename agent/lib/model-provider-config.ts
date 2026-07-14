/**
 * Runtime-selectable model provider configuration.
 *
 * Exports:
 * - `ModelProviderConfig`: strict text, vision, and voice model contract.
 * - `parseModelProviderConfig`: validates decoded server configuration.
 * - `modelProviderConfig`: validated configuration loaded from the canonical runtime path.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { AppError } from "./app-error.js";

const MODEL_PROVIDER_CONFIG_PATH = resolve(process.cwd(), "config/model-providers.json");
const modelIdSchema = z.string().trim().min(1).max(200);
const modalitySchema = z.enum(["text", "image"]);
const upstreamModelSchema = z.object({
  alias: modelIdSchema,
  inputModalities: z.array(modalitySchema).min(1),
  name: modelIdSchema,
  outputModalities: z.array(z.literal("text")).min(1),
}).strict();
const modelProviderConfigSchema = z.object({
  agent: z.object({
    contextWindowTokens: z.number().int().positive(),
    textModelId: modelIdSchema,
    upstream: z.object({
      baseUrl: z.url().refine((value) => value.startsWith("https://")),
      models: z.array(upstreamModelSchema).min(1).max(100),
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    }).strict(),
    visionModelId: modelIdSchema,
  }).strict(),
  schemaVersion: z.literal(1),
  voice: z.object({
    transcriptionModelId: modelIdSchema,
  }).strict(),
}).strict().superRefine((config, context) => {
  const aliases = new Set<string>();
  for (const model of config.agent.upstream.models) {
    if (aliases.has(model.alias)) {
      context.addIssue({ code: "custom", path: ["agent", "upstream", "models"], message: "duplicate alias" });
    }
    aliases.add(model.alias);
  }

  const textModel = config.agent.upstream.models.find(
    (model) => model.alias === config.agent.textModelId,
  );
  if (!textModel?.inputModalities.includes("text")) {
    context.addIssue({ code: "custom", path: ["agent", "textModelId"], message: "unknown text alias" });
  }
  const visionModel = config.agent.upstream.models.find(
    (model) => model.alias === config.agent.visionModelId,
  );
  if (!visionModel?.inputModalities.includes("image")) {
    context.addIssue({ code: "custom", path: ["agent", "visionModelId"], message: "unknown vision alias" });
  }
});

export type ModelProviderConfig = z.infer<typeof modelProviderConfigSchema>;

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

function loadModelProviderConfig(): ModelProviderConfig {
  try {
    const source = readFileSync(MODEL_PROVIDER_CONFIG_PATH, "utf8");
    return parseModelProviderConfig(JSON.parse(source));
  } catch (error) {
    // Keep the original filesystem/parser error while making startup diagnostics searchable.
    if (error instanceof Error && !error.message.includes("AGENT_MODEL_PROVIDER_CONFIG_INVALID")) {
      Object.defineProperty(error, "message", {
        configurable: true,
        value: `AGENT_MODEL_PROVIDER_CONFIG_INVALID: ${error.message}`,
        writable: true,
      });
    }
    throw error;
  }
}

export const modelProviderConfig = loadModelProviderConfig();
