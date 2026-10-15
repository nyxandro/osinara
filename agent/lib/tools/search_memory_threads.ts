/**
 * Scoped semantic memory-thread title search tool.
 *
 * Export:
 * - `search_memory_threads`: finds authorized broad/focused threads by title and purpose.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { THREAD_HISTORY_PAGE_MAX_ENTRIES } from "../memory-config.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { memoryThreadQueryRepository } from "../memory-thread-query-repository.js";

export default defineTool({
  // Repeating it after a crash is safe: it only reads.
  replaySafe: true,
  description: "Найти нить памяти (длинную тему с историей) по смыслу её названия или назначения, когда человек упоминает проект или цель, о которых шла речь раньше. Возвращает threadRef для read_memory_thread.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(THREAD_HISTORY_PAGE_MAX_ENTRIES).default(10),
    query: z.string().trim().min(1).max(500),
  }).strict(),
  async execute(input, ctx) {
    return await memoryThreadQueryRepository.search(
      requireMemoryAuthorization(ctx),
      input.query,
      input.limit,
    );
  },
});
