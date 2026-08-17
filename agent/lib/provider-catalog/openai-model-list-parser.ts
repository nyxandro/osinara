/**
 * OpenAI-compatible ID-only catalog parser.
 *
 * Exports:
 * - `parseOpenAiModelList`: validates OpenAI-compatible provider `/models` envelopes.
 * - `OpenAiModelListEntry`: validated model identifier returned by the provider.
 */
import { z } from "zod";

import { providerCatalogError } from "./provider-catalog-errors.js";
import type { ProviderId } from "./provider-catalog-types.js";

const openAiModelListSchema = z.object({
  object: z.literal("list"),
  data: z.array(z.object({
    id: z.string().trim().min(1),
    object: z.literal("model"),
    owned_by: z.string().trim().min(1),
  }).passthrough()),
}).passthrough();

export interface OpenAiModelListEntry {
  id: string;
}

/** The list providers expose no reliable capability metadata beyond IDs and ownership. */
export function parseOpenAiModelList(
  providerId: Exclude<ProviderId, "openrouter">,
  body: unknown,
): OpenAiModelListEntry[] {
  const result = openAiModelListSchema.safeParse(body);
  if (!result.success) {
    throw providerCatalogError("response-invalid", providerId);
  }

  return result.data.data.map(({ id }) => ({ id }));
}
