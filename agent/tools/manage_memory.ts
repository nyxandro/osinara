/**
 * Consolidated long-term memory mutation tool.
 *
 * Export:
 * - `manage_memory`: routes explicit edit, delete, and immediate undo actions.
 *
 * Key constructs:
 * - Object-shaped model schema avoids fragile root action unions.
 * - Action validators keep memory mutations fail-closed on malformed model payloads.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { MEMORY_CONTENT_MAX_LENGTH } from "../lib/memory-config.js";
import { requireAllowedMemoryContent } from "../lib/memory-content-policy.js";
import { requireMemoryAuthorization } from "../lib/memory-context.js";
import type { MemoryKind, MemorySensitivity } from "../lib/memory-record.js";
import { memoryRepository } from "../lib/memory-repository.js";
import {
  optionalEnum,
  requireAction,
  requiredString,
  requiredUuid,
  requireInputRecord,
  requireOnlyFields,
} from "../lib/tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_MEMORY_INPUT_INVALID";
const TOOL_ACTIONS = ["edit", "delete", "undo"] as const;
const MEMORY_KINDS = ["profile", "preference", "fact", "episode", "family_shared"] as const;
const MEMORY_SENSITIVITIES = ["normal", "sensitive"] as const;
const TOP_LEVEL_FIELDS = ["action", "content", "id", "kind", "sensitivity"] as const;

const manageMemorySchema = z.object({
  action: z.string().optional(),
  content: z.string().optional(),
  id: z.string().optional(),
  kind: z.string().optional(),
  sensitivity: z.string().optional(),
}).passthrough();

type MemoryAction = (typeof TOOL_ACTIONS)[number];

function requireMemoryId(input: Record<string, unknown>): string {
  return requiredUuid(input, "id", INPUT_ERROR_CODE, "запись из search_memories или list_memories");
}

function requireEditInput(input: Record<string, unknown>) {
  requireOnlyFields(input, ["action", "content", "id", "kind", "sensitivity"], "action=edit", INPUT_ERROR_CODE);
  const kind = optionalEnum(input, "kind", MEMORY_KINDS, INPUT_ERROR_CODE) as MemoryKind | undefined;
  const sensitivity = optionalEnum(
    input,
    "sensitivity",
    MEMORY_SENSITIVITIES,
    INPUT_ERROR_CODE,
  ) as MemorySensitivity | undefined;
  return {
    ...(kind === undefined ? {} : { kind }),
    content: requiredString(input, "content", INPUT_ERROR_CODE, "Исправленный текст памяти", {
      maxLength: MEMORY_CONTENT_MAX_LENGTH,
    }),
    id: requireMemoryId(input),
    ...(sensitivity === undefined ? {} : { sensitivity }),
  };
}

function requireIdOnlyInput(input: Record<string, unknown>, action: MemoryAction): string {
  requireOnlyFields(input, ["action", "id"], `action=${action}`, INPUT_ERROR_CODE);
  return requireMemoryId(input);
}

const TOOL_DESCRIPTION = [
  "Исправить доступную запись долговременной памяти, удалить её или отменить только что выполненное сохранение.",
  "Перед edit/delete сначала найди id через search_memories или list_memories.",
  "Edit payload: {\"action\":\"edit\",\"id\":\"uuid\",\"content\":\"Исправленный текст\",\"kind\":\"preference\",\"sensitivity\":\"normal\"}. kind и sensitivity необязательны.",
  "Delete payload: {\"action\":\"delete\",\"id\":\"uuid\"}. Undo payload используется только для немедленной отмены предложенного сохранения: {\"action\":\"undo\",\"id\":\"uuid\"}.",
].join(" ");

export default defineTool({
  approval: ({ session, toolInput }) => {
    // Undo is the immediate reversal offered after creation; edit and delete remain confirmation-gated.
    if (toolInput?.action === "undo") return "not-applicable";
    return session.auth.current?.attributes.telegramChatType === "private"
      ? "user-approval"
      : "not-applicable";
  },
  description: TOOL_DESCRIPTION,
  inputSchema: manageMemorySchema,
  async execute(input, ctx) {
    const payload = requireInputRecord(input, "manage_memory", INPUT_ERROR_CODE);
    requireOnlyFields(payload, TOP_LEVEL_FIELDS, "manage_memory", INPUT_ERROR_CODE);
    const action = requireAction(payload, "manage_memory", TOOL_ACTIONS, INPUT_ERROR_CODE);
    const authorization = requireMemoryAuthorization(ctx);
    if (action === "edit") {
      const values = requireEditInput(payload);
      return await memoryRepository.update(authorization, {
        ...values,
        content: requireAllowedMemoryContent(values.content),
        operationKey: ctx.callId,
      });
    }

    return await memoryRepository.delete(authorization, requireIdOnlyInput(payload, action), ctx.callId);
  },
});
