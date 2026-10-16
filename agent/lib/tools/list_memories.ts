/**
 * Paginated long-term memory listing tool.
 *
 * Export:
 * - `list_memories` lists only records authorized for the current conversation.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { MEMORY_LIST_DEFAULT_LIMIT, MEMORY_LIST_MAX_LIMIT } from "../memory-config.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { memoryRepository } from "../memory-repository.js";
import { recordToolShows } from "../memory-tool-shows.js";
import { toModelMemory } from "../model-memory.js";

export default defineTool({
  // Repeating it after a crash is safe: it only reads.
  replaySafe: true,
  description: [
    "List the long-term memory records available in the current chat page by page.",
    "Result: {items,nextCursor}; items holds the current page, and nextCursor must be passed unchanged",
    "to the next call. The value null means there are no more records.",
    "history=true adds earlier versions of properties (status=superseded), for example when asked what it was before.",
  ].join(" "),
  inputSchema: z.object({
    cursor: z.string().optional(),
    history: z.boolean().optional().describe(
      "Also show earlier versions of properties: records with status=superseded. By default only current ones",
    ),
    limit: z.number().int().min(1).max(MEMORY_LIST_MAX_LIMIT).default(MEMORY_LIST_DEFAULT_LIMIT),
    scope: z.enum(["personal", "family", "group"]).optional(),
  }),
  async execute(input, ctx) {
    const page = await memoryRepository.list(requireMemoryAuthorization(ctx), input);
    // Listing is reading too: a record the model used from a page counts like any other show.
    await recordToolShows(ctx, page.items.map((item) => item.memoryRef), "list");
    return {
      items: page.items.map((item) => toModelMemory(item, item.sourceEvidence)),
      nextCursor: page.nextCursor,
    };
  },
});
