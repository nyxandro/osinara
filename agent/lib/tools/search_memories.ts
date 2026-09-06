/**
 * Explicit hybrid memory search tool.
 *
 * Export:
 * - `search_memories` runs local embedding plus scoped PostgreSQL hybrid retrieval.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { memoryContextExposureRepository } from "../memory-context-exposure-repository.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { retrieveRelevantMemories } from "../memory-retrieval.js";

export default defineTool({
  description: [
    "Найти по словам и смыслу релевантные записи долговременной памяти в доступных областях для углубления контекста перед сложным ответом или действием.",
    "Если автоматической подборки недостаточно, вызови инструмент до трёх раз с разными смысловыми формулировками и остановись, когда контекста достаточно или новые релевантные факты больше не находятся.",
  ].join(" "),
  inputSchema: z.object({ query: z.string().min(1).max(2_000) }),
  async execute({ query }, ctx) {
    const auth = requireMemoryAuthorization(ctx);
    const applicationSessionId = ctx.session.auth.current?.attributes.applicationSessionId;
    const exposure = typeof applicationSessionId === "string"
      ? {
          applicationSessionId,
          sessionTurn: await memoryContextExposureRepository.sessionTurn(applicationSessionId),
        }
      : undefined;
    return await retrieveRelevantMemories(auth, query, exposure);
  },
});
