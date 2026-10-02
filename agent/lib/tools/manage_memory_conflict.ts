/**
 * Explicit claim-conflict resolution tool.
 *
 * Export:
 * - `manage_memory_conflict`: chooses one version, keeps both, or records an unresolved decision.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { memoryConflictRepository } from "../memory-conflict-repository.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { MEMORY_REF_PATTERN } from "../model-memory.js";
import { AppError } from "../app-error.js";

const conflictInputSchema = z.object({
  action: z.enum(["choose", "keep_both", "keep_unresolved"]),
  conflictRef: z.string(),
  memoryRef: z.string().optional(),
}).strict();
const CONFLICT_REF_PATTERN = /^conf_[0-9a-f]{32}$/u;

function invalidInput(): AppError {
  return new AppError(
    "AGENT_MEMORY_CONFLICT_INPUT_INVALID",
    "Передайте explicit action и безопасные conflictRef/memoryRef из блока конфликта",
  );
}

export default defineTool({
  description: [
    "Разрешить показанный конфликт памяти только по явному решению пользователя.",
    "choose требует conflictRef и memoryRef выбранной версии; keep_both сохраняет обе версии;",
    "keep_unresolved фиксирует решение пока не выбирать. Никогда не выбирай версию самостоятельно.",
  ].join(" "),
  inputSchema: conflictInputSchema,
  async execute(input, ctx) {
    const parsed = conflictInputSchema.safeParse(input);
    if (!parsed.success || !CONFLICT_REF_PATTERN.test(parsed.data.conflictRef)) throw invalidInput();
    if (
      parsed.data.action === "choose" &&
      (parsed.data.memoryRef === undefined || !MEMORY_REF_PATTERN.test(parsed.data.memoryRef))
    ) {
      throw invalidInput();
    }
    if (parsed.data.action !== "choose" && parsed.data.memoryRef !== undefined) throw invalidInput();
    const resolution = parsed.data.action === "choose"
      ? {
          action: parsed.data.action,
          conflictRef: parsed.data.conflictRef,
          memoryRef: parsed.data.memoryRef!,
        }
      : { action: parsed.data.action, conflictRef: parsed.data.conflictRef };
    return await memoryConflictRepository.resolve(
      requireMemoryAuthorization(ctx),
      { ...resolution, operationKey: ctx.callId },
    );
  },
});
