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
import { defineTool, type ToolContext } from "../../runtime/tool.js";
import { z } from "zod";

import { MEMORY_CONTENT_MAX_LENGTH } from "../memory-config.js";
import { requireAllowedMemoryContent } from "../memory-content-policy.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import type { MemoryKind, MemorySensitivity } from "../memory-record.js";
import { memoryRepository } from "../memory-repository.js";
import { MEMORY_UNDO_DENIED_MESSAGE } from "../memory-undo-repository.js";
import { MEMORY_REF_PATTERN, toModelMemory } from "../model-memory.js";
import {
  optionalEnum,
  requireAction,
  requiredString,
  requireInputRecord,
  requireOnlyFields,
  toolInputError,
} from "../tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_MEMORY_INPUT_INVALID";
export const MANAGE_MEMORY_ACTIONS = ["edit", "delete", "undo"] as const;
const MEMORY_KINDS = ["profile", "preference", "fact", "episode", "family_shared"] as const;
const MEMORY_SENSITIVITIES = ["normal", "sensitive"] as const;
const TOP_LEVEL_FIELDS = ["action", "content", "kind", "memoryRef", "sensitivity"] as const;

export type ManageMemoryAction = (typeof MANAGE_MEMORY_ACTIONS)[number];

const ACTION_DESCRIPTIONS: Readonly<Record<ManageMemoryAction, string>> = {
  delete: 'Delete payload: {"action":"delete","memoryRef":"mem_..."}.',
  edit:
    'Edit payload: {"action":"edit","memoryRef":"mem_...","content":"Исправленный текст","kind":"preference","sensitivity":"normal"}. kind и sensitivity необязательны.',
  undo:
    'Undo используется только для немедленной отмены сохранения: {"action":"undo","memoryRef":"mem_..."}.',
};

export function manageMemoryPresentation(actions: readonly ManageMemoryAction[]) {
  const [firstAction, ...otherActions] = actions;
  if (firstAction === undefined) throw new Error("manage_memory requires at least one action");
  const canEdit = actions.includes("edit");
  const mutableActions = actions.filter((action) => action !== "undo");
  return {
    description: [
      "Управлять доступной записью долговременной памяти только через перечисленные операции.",
      mutableActions.length > 0
        ? `Перед ${mutableActions.join("/")} сначала получи memoryRef через remember, search_memories или list_memories.`
        : null,
      canEdit
        ? "Edit передаёт полную новую версию записи: обогащай или исправляй её, сохранив все актуальные детали исходного текста."
        : null,
      mutableActions.length > 0
        ? "Самостоятельно не выполняй необоснованную мутацию, которая ухудшает точность, полноту либо будущую полезность памяти."
        : null,
      ...MANAGE_MEMORY_ACTIONS
        .filter((action) => actions.includes(action))
        .map((action) => ACTION_DESCRIPTIONS[action]),
    ].filter((section): section is string => section !== null).join(" "),
    inputSchema: z.object({
      action: z.enum([firstAction, ...otherActions]),
      content: z.string().optional(),
      kind: z.string().optional(),
      memoryRef: z.string().optional(),
      sensitivity: z.string().optional(),
    }).strict(),
  };
}

function requireMemoryRef(input: Record<string, unknown>): string {
  const memoryRef = requiredString(
    input,
    "memoryRef",
    INPUT_ERROR_CODE,
    "mem_0123456789abcdef0123456789abcdef",
  );
  if (!MEMORY_REF_PATTERN.test(memoryRef)) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Поле memoryRef должно быть безопасной ссылкой из remember, search_memories или list_memories",
    );
  }
  return memoryRef;
}

function requireEditInput(input: Record<string, unknown>) {
  requireOnlyFields(
    input,
    ["action", "content", "kind", "memoryRef", "sensitivity"],
    "action=edit",
    INPUT_ERROR_CODE,
  );
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
    memoryRef: requireMemoryRef(input),
    ...(sensitivity === undefined ? {} : { sensitivity }),
  };
}

function requireRefOnlyInput(input: Record<string, unknown>, action: ManageMemoryAction): string {
  requireOnlyFields(input, ["action", "memoryRef"], `action=${action}`, INPUT_ERROR_CODE);
  return requireMemoryRef(input);
}

function requireCurrentCorrectionSource(ctx: ToolContext) {
  const attributes = ctx.session.auth.current?.attributes;
  const conversationId = attributes?.telegramConversationId;
  const timelineEntryId = attributes?.telegramTimelineEntryId;
  if (typeof conversationId !== "string" || typeof timelineEntryId !== "string") {
    toolInputError(
      "AGENT_MEMORY_CORRECTION_SOURCE_INVALID",
      "Не удалось подтвердить текущее сообщение как источник исправления памяти",
    );
  }
  return { conversationId, timelineEntryId };
}

function requireManageMemoryInput(input: unknown) {
  const payload = requireInputRecord(input, "manage_memory", INPUT_ERROR_CODE);
  requireOnlyFields(payload, TOP_LEVEL_FIELDS, "manage_memory", INPUT_ERROR_CODE);
  const action = requireAction(payload, "manage_memory", MANAGE_MEMORY_ACTIONS, INPUT_ERROR_CODE);

  // Approval and execution share semantic parsing so malformed mutations never reach a repository.
  if (action === "edit") return { action, values: requireEditInput(payload) } as const;
  return { action, memoryRef: requireRefOnlyInput(payload, action) } as const;
}

function currentProvenance(session: { id: string; turn: { id: string } }) {
  return { sessionId: session.id, turnId: session.turn.id };
}

const TOOL_PRESENTATION = manageMemoryPresentation(MANAGE_MEMORY_ACTIONS);

export default defineTool({
  // Repeating it after a crash is safe: its effect is keyed on the call id.
  replaySafe: true,
  approval: async ({ session, toolInput }) => {
    const parsed = requireManageMemoryInput(toolInput);
    const authorization = requireMemoryAuthorization({ session });
    if (parsed.action === "undo") {
      const allowed = await memoryRepository.canUndoCreate(
        authorization,
        parsed.memoryRef,
        currentProvenance(session),
      );
      return allowed
        ? "not-applicable"
        : {
            type: "denied",
            reason: `AGENT_MEMORY_UNDO_DENIED: ${MEMORY_UNDO_DENIED_MESSAGE}`,
          };
    }

    // Решение о фактах принимает агент: подтверждение здесь было лишним трением. Безопасность даёт
    // мягкое удаление — строка скрывается из всех чтений и из векторной выдачи, но остаётся в базе.
    return "not-applicable";
  },
  ...TOOL_PRESENTATION,
  async execute(input, ctx) {
    const parsed = requireManageMemoryInput(input);
    const authorization = requireMemoryAuthorization(ctx);
    if (parsed.action === "edit") {
      const updated = await memoryRepository.updateByRef(authorization, {
        ...parsed.values,
        content: requireAllowedMemoryContent(parsed.values.content),
        operationKey: ctx.callId,
        source: requireCurrentCorrectionSource(ctx),
      });
      return toModelMemory(updated);
    }

    if (parsed.action === "undo") {
      return await memoryRepository.undoCreate(authorization, parsed.memoryRef, {
        operationKey: ctx.callId,
        ...currentProvenance(ctx.session),
      });
    }

    return await memoryRepository.deleteByRef(authorization, parsed.memoryRef, ctx.callId);
  },
});
