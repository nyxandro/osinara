/**
 * Turn-level memory retrieval orchestration.
 *
 * Exports:
 * - `latestUserText`: extracts the newest user text from Eve model history.
 * - `retrieveRelevantMemories`: embeds a query locally and runs scoped hybrid search.
 */
import type { ModelMessage } from "ai";

import { embedMemoryQuery } from "./memory-embedding-client.js";
import type { MemoryAuthorization } from "./memory-context.js";
import type { MemoryItem } from "./memory-record.js";
import { memoryRetrievalRepository } from "./memory-retrieval-repository.js";

export function latestUserText(messages: readonly ModelMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content.trim() || null;
    const text = message.content
      .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> =>
        part.type === "text",
      )
      .map((part) => part.text)
      .join("\n")
      .trim();
    return text || null;
  }
  return null;
}

export async function retrieveRelevantMemories(
  auth: MemoryAuthorization,
  query: string,
): Promise<MemoryItem[]> {
  const embedding = await embedMemoryQuery(query);
  return await memoryRetrievalRepository.search(auth, query, embedding);
}
