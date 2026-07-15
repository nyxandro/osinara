/**
 * Paginated long-term memory listing tool.
 *
 * Export:
 * - `list_memories` lists only records authorized for the current conversation.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { MEMORY_LIST_DEFAULT_LIMIT, MEMORY_LIST_MAX_LIMIT } from "../lib/memory-config.js";
import { requireMemoryAuthorization } from "../lib/memory-context.js";
import { memoryRepository } from "../lib/memory-repository.js";

export default defineTool({
  description: "Постранично показать записи долговременной памяти, доступные в текущем чате.",
  inputSchema: z.object({
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(MEMORY_LIST_MAX_LIMIT).default(MEMORY_LIST_DEFAULT_LIMIT),
    scope: z.enum(["personal", "family", "group"]).optional(),
  }),
  async execute(input, ctx) {
    return await memoryRepository.list(requireMemoryAuthorization(ctx), input);
  },
});
