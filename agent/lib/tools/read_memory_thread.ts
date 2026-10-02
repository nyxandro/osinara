/**
 * Bounded source-backed memory-thread history tool.
 *
 * Export:
 * - `read_memory_thread`: deepens one authorized thread by at most 20 entries / 12k characters.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { THREAD_HISTORY_PAGE_MAX_ENTRIES } from "../memory-config.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import {
  memoryThreadQueryRepository,
  THREAD_ENTRY_REF_PATTERN,
  THREAD_REF_PATTERN,
} from "../memory-thread-query-repository.js";

export default defineTool({
  // Repeating it after a crash is safe: it only reads.
  replaySafe: true,
  description:
    "Прочитать bounded страницу source-backed истории нити по opaque threadRef; используй cursor для углубления.",
  inputSchema: z.object({
    cursor: z.string().regex(THREAD_ENTRY_REF_PATTERN).optional(),
    limit: z.number().int().min(1).max(THREAD_HISTORY_PAGE_MAX_ENTRIES).default(20),
    threadRef: z.string().regex(THREAD_REF_PATTERN),
  }).strict(),
  async execute(input, ctx) {
    return await memoryThreadQueryRepository.read(
      requireMemoryAuthorization(ctx),
      input.threadRef,
      { cursor: input.cursor, limit: input.limit },
    );
  },
});
