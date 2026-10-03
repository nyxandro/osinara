/**
 * Paginated scoped memory-thread listing tool.
 *
 * Export:
 * - `list_memory_threads`: returns model-safe summaries with opaque thread refs.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { THREAD_HISTORY_PAGE_MAX_ENTRIES } from "../memory-config.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { memoryThreadQueryRepository, THREAD_REF_PATTERN } from "../memory-thread-query-repository.js";

export default defineTool({
  // Repeating it after a crash is safe: it only reads.
  replaySafe: true,
  description: "Постранично показать доступные нити памяти без загрузки их полной истории.",
  inputSchema: z.object({
    cursor: z.string().regex(THREAD_REF_PATTERN).optional(),
    limit: z.number().int().min(1).max(THREAD_HISTORY_PAGE_MAX_ENTRIES).default(20),
    scope: z.enum(["personal", "family", "group"]).optional(),
    status: z.enum(["active", "completed"]).optional(),
  }).strict(),
  async execute(input, ctx) {
    return await memoryThreadQueryRepository.list(requireMemoryAuthorization(ctx), input);
  },
});
