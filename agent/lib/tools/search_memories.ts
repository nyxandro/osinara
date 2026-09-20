/**
 * Explicit hybrid memory search tool.
 *
 * Export:
 * - `search_memories` runs local embedding plus scoped PostgreSQL hybrid retrieval.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireMemoryAuthorization } from "../memory-context.js";
import { currentTimeRepository } from "../current-time-repository.js";
import {
  memoryEventWindowRepository,
  MEMORY_EVENT_WINDOW_LIMIT,
} from "../memory-event-window-repository.js";
import {
  retrieveRelevantMemories,
  type MemoryRetrievalDiagnostics,
  type ModelMemoryContextItem,
} from "../memory-retrieval.js";
import { memorySelectionMetrics } from "../memory-observability.js";
import { toModelMemory } from "../model-memory.js";

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
// Open ends of a period, not defaults for missing data: the column itself is bounded to this range.
const EARLIEST_SEARCHABLE_DAY = "1900-01-01";
const LATEST_SEARCHABLE_DAY = "2100-01-01";

export default defineTool({
  description: [
    "Найти по словам и смыслу сохранённые сведения об участниках, их опыте, прежних обсуждениях, решениях и рекомендациях в доступных областях памяти. Это не поиск в интернете; не используй для внешних сведений и готовых материалов без связи с историей пользователя или чата.",
    "Если для такого вопроса автоматической подборки недостаточно, вызови инструмент до трёх раз с разными смысловыми формулировками и остановись, когда контекста достаточно или новые релевантные факты больше не находятся.",
    "Для просьбы вспомнить прошлое или дать ту ссылку сначала восстанови предмет по явному названию или описанию из видимой переписки; пустая автоматическая подборка не доказывает отсутствие записи.",
    "Для вопроса про период (что было в августе, о чём договорились на прошлой неделе) задавай from и to: тогда отбор идёт по дате события, а у записей без неё по дате появления. В этом режиме query не участвует в отборе.",
    `Период возвращает не больше ${MEMORY_EVENT_WINDOW_LIMIT} записей, самые поздние по дате события. Если их ровно столько, период мог не поместиться целиком: сузь его и повтори.`,
    "Обычно результат это массив записей. Если вместо него пришёл объект с полем incompleteSelection, подбор собран только по словам и неполон: скажи об этом человеку, а не делай вывод, что сведения нет.",
  ].join(" "),
  inputSchema: z.object({
    from: DAY.optional().describe("Начало периода, ГГГГ-ММ-ДД: отбирает записи по дате события"),
    query: z.string().min(1).max(2_000),
    to: DAY.optional().describe("Конец периода, ГГГГ-ММ-ДД, включительно"),
  }),
  async execute({ from, query, to }, ctx) {
    const started = performance.now();
    let found: ModelMemoryContextItem[] | null = null;
    let diagnostics: MemoryRetrievalDiagnostics | null = null;
    const auth = requireMemoryAuthorization(ctx);
    try {
      // A period is a different question from a phrase, and it is answered by the dates alone:
      // the words of the query would only re-rank what the period already selected.
      if (from !== undefined || to !== undefined) {
        const window = await memoryEventWindowRepository.search(auth, {
          from: from ?? EARLIEST_SEARCHABLE_DAY,
          // A record without an event date falls back to the day it appeared, and which day that
          // was depends on where the person lives, not on where the database runs.
          timezone: auth.userId === null
            ? null
            : await currentTimeRepository.findUserTimezone(auth.userId, auth.familyId),
          to: to ?? LATEST_SEARCHABLE_DAY,
        });
        found = window.map((item) => toModelMemory(item));
        return found;
      }
      const result = await retrieveRelevantMemories(auth, query);
      found = result.memories;
      diagnostics = result.diagnostics;
      // Without the semantic branch a paraphrase simply does not match, and an empty result read
      // as «этого нет» is worse than no answer at all.
      if (!result.diagnostics.semanticBranchAvailable) {
        return {
          incompleteSelection: "Смысловая ветка поиска сейчас недоступна: найдено только по точным словам, перефразированный вопрос мог не найтись. Не делай вывода, что сведения нет.",
          items: found,
        };
      }
      return found;
    } finally {
      console.info(JSON.stringify({ code: "AGENT_MEMORY_SEARCH_METRICS",
        sessionId: ctx.session.id, turnId: ctx.session.turn.id, callId: ctx.callId,
        outcome: found === null ? "failed" : "succeeded",
        window: from === undefined && to === undefined ? null : { from: from ?? null, to: to ?? null },
        ...memorySelectionMetrics(found),
        ...diagnostics,
        durationMs: Math.round(performance.now() - started),
      }));
    }
  },
});
