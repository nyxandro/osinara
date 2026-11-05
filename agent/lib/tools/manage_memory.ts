/**
 * Long-term memory records: list them and change one.
 *
 * Exports:
 * - `manage_memory`: lists the available records page by page and routes explicit edit, delete and
 *   immediate undo actions.
 * - `manageMemoryPresentation`: the descriptor of a chosen set of actions, for a place that may use
 *   only some of them (an external group by its rights, a delegated task, a silent review).
 *
 * Key constructs:
 * - Object-shaped model schema avoids fragile root action unions.
 * - Action validators keep memory mutations fail-closed on malformed model payloads.
 * - The list replaced the separate list tool (#457); it changes nothing and asks no confirmation.
 */
import { defineTool, type ToolContext } from "../../runtime/tool.js";
import { z } from "zod";

import { isAppError } from "../app-error.js";
import { MEMORY_CONTENT_MAX_LENGTH, MEMORY_LIST_DEFAULT_LIMIT, MEMORY_LIST_MAX_LIMIT } from "../memory-config.js";
import { requireAllowedMemoryContent } from "../memory-content-policy.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import type { MemoryKind, MemorySensitivity } from "../memory-record.js";
import { memoryRepository } from "../memory-repository.js";
import { MEMORY_UNDO_DENIED_MESSAGE } from "../memory-undo-repository.js";
import { recordToolShows } from "../memory-tool-shows.js";
import { MEMORY_REF_PATTERN, toModelMemory } from "../model-memory.js";
import {
  optionalEnum,
  pageInput,
  requireAction,
  requiredString,
  requireInputRecord,
  requireOnlyFields,
  toolInputError,
} from "../tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_MEMORY_INPUT_INVALID";
export const MANAGE_MEMORY_ACTIONS = ["list", "edit", "delete", "undo"] as const;
const MEMORY_KINDS = ["profile", "preference", "fact", "episode", "family_shared"] as const;
const MEMORY_SENSITIVITIES = ["normal", "sensitive"] as const;
const LIST_SCOPES = ["personal", "family", "group"] as const;
const TOP_LEVEL_FIELDS = [
  "action", "content", "cursor", "history", "kind", "limit", "memoryRef", "scope", "sensitivity",
] as const;

export type ManageMemoryAction = (typeof MANAGE_MEMORY_ACTIONS)[number];

const LIST_WITHOUT_HISTORY =
  'List shows the available records page by page: {"action":"list"}; the result is {items,nextCursor}, and a not-null nextCursor goes back unchanged as cursor for the next page.';

const ACTION_DESCRIPTIONS: Readonly<Record<ManageMemoryAction, string>> = {
  list:
    'List shows the available records page by page: {"action":"list"}; the result is {items,nextCursor}, and a not-null nextCursor goes back unchanged as cursor for the next page. history=true adds earlier versions of properties (status=superseded), for example when asked what it was before.',
  delete: 'Delete payload: {"action":"delete","memoryRef":"mem_..."}.',
  edit:
    'Edit payload: {"action":"edit","memoryRef":"mem_...","content":"Исправленный текст","kind":"preference","sensitivity":"normal"}. kind and sensitivity are optional.',
  undo:
    'Use undo only to cancel a save immediately: {"action":"undo","memoryRef":"mem_..."}.',
};

/**
 * `listScopes` narrows the scope a list may name and `area` names whose memory it is: an external
 * group has only its own. `history: false` keeps earlier versions out of the list, as an external
 * group's list never had them. A place that may only list gets no fields of a change in its schema.
 */
export function manageMemoryPresentation(
  actions: readonly ManageMemoryAction[],
  options: {
    readonly area?: string;
    readonly history?: boolean;
    readonly listScopes?: readonly [string, ...string[]];
  } = {},
) {
  const [firstAction, ...otherActions] = actions;
  if (firstAction === undefined) throw new Error("manage_memory requires at least one action");
  const canEdit = actions.includes("edit");
  const mutableActions = actions.filter((action) => action === "edit" || action === "delete");
  const lists = actions.includes("list");
  const changes = actions.some((action) => action !== "list");
  const history = lists && options.history !== false;
  const listScopes = options.listScopes ?? LIST_SCOPES;
  const records = options.area === undefined ? "the available long-term memory records" : `the long-term memory records ${options.area}`;
  return {
    description: [
      !changes
        ? `List ${records}; here they can only be read.`
        : lists
          ? `List ${records} or change one, only through the listed operations.`
          : `Work with ${records} only through the listed operations.`,
      mutableActions.length > 0
        ? `Before ${mutableActions.join("/")} first get the memoryRef through remember, search_memories${lists ? " or the list" : ""}.`
        : null,
      canEdit
        ? "Edit passes the full new version of the record: enrich or correct it, keeping all current details of the original text."
        : null,
      mutableActions.length > 0
        ? "Do not perform an unjustified mutation on your own that degrades the accuracy, completeness or future usefulness of memory."
        : null,
      ...MANAGE_MEMORY_ACTIONS
        .filter((action) => actions.includes(action))
        .map((action) => action === "list" && !history ? LIST_WITHOUT_HISTORY : ACTION_DESCRIPTIONS[action]),
    ].filter((section): section is string => section !== null).join(" "),
    inputSchema: z.object({
      action: z.enum([firstAction, ...otherActions]),
      ...(lists ? {
        cursor: z.string().optional().describe("Only in list: nextCursor of the previous page, unchanged."),
        ...(history ? {
          history: z.boolean().optional().describe(
            "Only in list: also show earlier versions of properties, records with status=superseded. By default only current ones",
          ),
        } : {}),
        limit: z.number().int().min(1).max(MEMORY_LIST_MAX_LIMIT).optional().describe("Only in list: the page size."),
        scope: z.enum(listScopes as [string, ...string[]]).optional().describe("Only in list: one memory scope."),
      } : {}),
      ...(changes ? {
        content: z.string().optional(),
        kind: z.enum(MEMORY_KINDS).optional(),
        memoryRef: z.string().optional(),
        sensitivity: z.enum(MEMORY_SENSITIVITIES).optional(),
      } : {}),
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
      "Поле memoryRef должно быть безопасной ссылкой из remember, search_memories или manage_memory с action=list",
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

function requireListInput(input: Record<string, unknown>) {
  requireOnlyFields(input, ["action", "cursor", "history", "limit", "scope"], "action=list", INPUT_ERROR_CODE);
  const history = input.history;
  if (history !== undefined && typeof history !== "boolean") {
    toolInputError(INPUT_ERROR_CODE, "Поле history должно быть true или false");
  }
  const scope = optionalEnum(input, "scope", LIST_SCOPES, INPUT_ERROR_CODE);
  return {
    ...pageInput(input, INPUT_ERROR_CODE, { defaultLimit: MEMORY_LIST_DEFAULT_LIMIT, maxLimit: MEMORY_LIST_MAX_LIMIT }),
    ...(history === undefined ? {} : { history }),
    ...(scope === undefined ? {} : { scope }),
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
  if (action === "list") return { action, page: requireListInput(payload) } as const;
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
    // Reading the list changes nothing: no confirmation, and no access check here that could end the turn.
    if ((toolInput as { action?: unknown } | undefined)?.action === "list") return "not-applicable";
    let parsed: ReturnType<typeof requireManageMemoryInput>;
    try {
      parsed = requireManageMemoryInput(toolInput);
    } catch (error) {
      // A malformed call goes on to execution, whose own check refuses it before any change and
      // answers the model; thrown here, it would end the turn.
      if (isAppError(error)) return "not-applicable";
      throw error;
    }
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
    if (parsed.action === "list") {
      const page = await memoryRepository.list(authorization, parsed.page);
      // Listing is reading too: a record the model used from a page counts like any other show.
      await recordToolShows(ctx, page.items.map((item) => item.memoryRef), "list");
      return {
        items: page.items.map((item) => toModelMemory(item, item.sourceEvidence)),
        nextCursor: page.nextCursor,
      };
    }
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
