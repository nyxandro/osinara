/**
 * Explicit hybrid memory search tool.
 *
 * Export:
 * - `search_memories` runs local embedding plus scoped PostgreSQL hybrid retrieval.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireMemoryAuthorization } from "../memory-context.js";
import { retrieveRelevantMemories } from "../memory-retrieval.js";
import { memorySelectionMetrics } from "../memory-observability.js";

export default defineTool({
  description: [
    "Найти по словам и смыслу релевантные записи долговременной памяти в доступных областях для углубления контекста перед сложным ответом или действием.",
    "Если автоматической подборки недостаточно, вызови инструмент до трёх раз с разными смысловыми формулировками и остановись, когда контекста достаточно или новые релевантные факты больше не находятся.",
    "Для просьбы вспомнить прошлое или дать ту ссылку сначала восстанови предмет по видимой переписке и ищи по явному названию или описанию; пустая автоматическая подборка не доказывает отсутствие записи.",
  ].join(" "),
  inputSchema: z.object({ query: z.string().min(1).max(2_000) }),
  async execute({ query }, ctx) {
    const started = performance.now();
    let result: Awaited<ReturnType<typeof retrieveRelevantMemories>> | null = null;
    try {
      result = await retrieveRelevantMemories(requireMemoryAuthorization(ctx), query);
      return result;
    } finally {
      console.info(JSON.stringify({ code: "AGENT_MEMORY_SEARCH_METRICS",
        sessionId: ctx.session.id, turnId: ctx.session.turn.id, callId: ctx.callId,
        outcome: result === null ? "failed" : "succeeded", ...memorySelectionMetrics(result),
        durationMs: Math.round(performance.now() - started),
      }));
    }
  },
});
