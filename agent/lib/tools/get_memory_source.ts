/**
 * Personal provenance lookup tool.
 *
 * Export:
 * - `get_memory_source`: returns a safe, currently authorized source summary for an opaque memoryRef.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { requireMemoryAuthorization } from "../memory-context.js";
import { memorySourceRepository } from "../memory-source-repository.js";
import { MEMORY_REF_PATTERN } from "../model-memory.js";

export default defineTool({
  // Repeating it after a crash is safe: it only reads.
  replaySafe: true,
  description:
    "Показать безопасное происхождение записи личного эффективного профиля по opaque memoryRef.",
  inputSchema: z.object({
    memoryRef: z.string().regex(MEMORY_REF_PATTERN),
  }).strict(),
  async execute(input, ctx) {
    return await memorySourceRepository.lookup(requireMemoryAuthorization(ctx), input.memoryRef);
  },
});
