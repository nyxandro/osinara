/**
 * Paginated long-term memory listing tool.
 *
 * Export:
 * - `list_memories` lists only records authorized for the current conversation.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { MEMORY_LIST_DEFAULT_LIMIT, MEMORY_LIST_MAX_LIMIT } from "../memory-config.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { memoryRepository } from "../memory-repository.js";
import { toModelMemory } from "../model-memory.js";

export default defineTool({
  description: [
    "Постранично показать записи долговременной памяти, доступные в текущем чате.",
    "Результат: {items,nextCursor}; items содержит текущую страницу, а nextCursor нужно без изменений",
    "передать в следующий вызов. Значение null означает, что записей больше нет.",
    "history=true добавляет прежние версии свойств (status=superseded) — например когда спрашивают, что было раньше.",
  ].join(" "),
  inputSchema: z.object({
    cursor: z.string().optional(),
    history: z.boolean().optional().describe(
      "Показать также прежние версии свойств: записи со status=superseded. По умолчанию только текущие",
    ),
    limit: z.number().int().min(1).max(MEMORY_LIST_MAX_LIMIT).default(MEMORY_LIST_DEFAULT_LIMIT),
    scope: z.enum(["personal", "family", "group"]).optional(),
  }),
  async execute(input, ctx) {
    const page = await memoryRepository.list(requireMemoryAuthorization(ctx), input);
    return {
      items: page.items.map((item) => toModelMemory(item, item.sourceEvidence)),
      nextCursor: page.nextCursor,
    };
  },
});
