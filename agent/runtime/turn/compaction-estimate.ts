/**
 * Rough token estimates for compaction decisions; the real count comes back from the provider
 * after each step.
 *
 * Exports:
 * - `estimateTokens`, `estimateTextTokens`: UTF-8 size / 4, of serialized JSON or of plain text.
 * - `estimateFrameTokens`: what every request carries besides the messages.
 *
 * Bytes, not characters: a Russian letter is two bytes and a token holds fewer letters than Latin
 * ones. A Russian conversation at characters / 4 came to about 70% of the provider's count, at
 * bytes / 4 to about 90%; the rest was the system prompt and the tool definitions. Latin text
 * counts the same either way.
 *
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import { asSchema, type ToolSet } from "ai";

export function estimateTokens(value: unknown): number {
  return estimateTextTokens(JSON.stringify(value));
}

export function estimateTextTokens(text: string): number {
  return Buffer.byteLength(text, "utf8") / 4;
}

/** The system prompt and the tool definitions as the provider receives them: name, description, JSON schema. */
export async function estimateFrameTokens(system: string, tools: ToolSet): Promise<number> {
  const definitions = await Promise.all(Object.entries(tools).map(async ([name, definition]) => ({
    description: definition.description,
    name,
    parameters: await asSchema(definition.inputSchema).jsonSchema,
  })));
  return estimateTextTokens(system) + estimateTokens(definitions);
}
