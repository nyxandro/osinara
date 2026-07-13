/**
 * Explicit hybrid memory search tool.
 *
 * Export:
 * - `search_memories` runs local embedding plus scoped PostgreSQL hybrid retrieval.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireMemoryAuthorization } from "../lib/memory-context.js";
import { retrieveRelevantMemories } from "../lib/memory-retrieval.js";

export default defineTool({
  description: "Найти по словам и смыслу релевантные записи в доступных областях памяти.",
  inputSchema: z.object({ query: z.string().min(1).max(2_000) }),
  async execute({ query }, ctx) {
    return await retrieveRelevantMemories(requireMemoryAuthorization(ctx), query);
  },
});
