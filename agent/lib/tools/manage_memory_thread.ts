/**
 * Memory threads: long topics with history. List, find and read them, complete or reactivate one.
 *
 * Exports:
 * - `manage_memory_thread`: every action; completion and reactivation are replay-protected.
 * - `manageMemoryThreadPresentation`: the descriptor of a chosen set of actions, for a place that may
 *   use only some of them (an external group by its rights, a delegated task, a silent review).
 * - `MEMORY_THREAD_ACTIONS`, `MEMORY_THREAD_READING_ACTIONS`.
 *
 * Key constructs:
 * - Reading replaced three separate tools (#457). It needs no verified Telegram message, so a
 *   scheduled run and a silent review read threads as before; a change still needs one.
 * - Each action takes only its own fields: a ref of the wrong kind is refused before any query.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { THREAD_HISTORY_PAGE_MAX_ENTRIES } from "../memory-config.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { memoryThreadLifecycleRepository } from "../memory-thread-lifecycle-repository.js";
import {
  memoryThreadQueryRepository,
  THREAD_ENTRY_REF_PATTERN,
  THREAD_REF_PATTERN,
} from "../memory-thread-query-repository.js";
import { optionalEnum, requireInputRecord, requireOnlyFields, toolInputError } from "../tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_MEMORY_THREAD_INPUT_INVALID";
export const MEMORY_THREAD_ACTIONS = ["list", "search", "read", "complete", "reactivate"] as const;
export const MEMORY_THREAD_READING_ACTIONS = ["list", "search", "read"] as const;
export type MemoryThreadAction = (typeof MEMORY_THREAD_ACTIONS)[number];

const LIST_SCOPES = ["personal", "family", "group"] as const;
const STATUSES = ["active", "completed"] as const;
const AUTHORITIES = ["current_user_statement", "confirmed_outcome"] as const;
const OUTCOME_REF_PATTERN = /^outcome_[0-9a-f]{32}$/u;
const QUERY_MAX_LENGTH = 500;
const LIST_DEFAULT_LIMIT = 20;
const SEARCH_DEFAULT_LIMIT = 10;
const READ_DEFAULT_LIMIT = 20;

const ACTION_FIELDS: Readonly<Record<MemoryThreadAction, readonly string[]>> = {
  list: ["action", "cursor", "limit", "scope", "status"],
  search: ["action", "limit", "query"],
  read: ["action", "cursor", "limit", "threadRef"],
  complete: ["action", "authority", "outcomeRef", "sourceEntryRefs", "threadRef"],
  reactivate: ["action", "threadRef"],
};

const ACTION_DESCRIPTIONS: Readonly<Record<MemoryThreadAction, string>> = {
  list: "List shows the threads page by page without their history: {\"action\":\"list\"}; scope and status narrow it. The result is {items,nextCursor}: take threadRef only from items and pass a not-null nextCursor back unchanged as cursor.",
  search: "Search finds a thread by the meaning of its name or purpose when the person mentions a project or goal discussed earlier: {\"action\":\"search\",\"query\":\"ремонт кухни\"}.",
  read: "Read returns a page of one thread's history with sources: {\"action\":\"read\",\"threadRef\":\"thread_...\"}; the next page goes through cursor.",
  complete: "Complete only after a verified current statement of the user or a confirmed outcome, with sourceEntryRefs from read: {\"action\":\"complete\",\"authority\":\"current_user_statement\",\"sourceEntryRefs\":[\"entry_...\"],\"threadRef\":\"thread_...\"}.",
  reactivate: "Reactivate only when the user directly asks to continue exactly the completed thread; a new goal usually creates a new subthread: {\"action\":\"reactivate\",\"threadRef\":\"thread_...\"}.",
};

const READING_VERBS: Readonly<Record<(typeof MEMORY_THREAD_READING_ACTIONS)[number], string>> = {
  list: "list",
  search: "find",
  read: "read",
};

const FIELD_SCHEMAS = (listScopes: readonly [string, ...string[]]) => ({
  authority: z.enum(AUTHORITIES).optional().describe("Required only for complete"),
  cursor: z.string().optional().describe("list: nextCursor of the previous page of threads; read: nextCursor of the previous page of entries"),
  limit: z.number().int().min(1).max(THREAD_HISTORY_PAGE_MAX_ENTRIES).optional().describe("The page size of list, search or read"),
  outcomeRef: z.string().regex(OUTCOME_REF_PATTERN).optional()
    .describe("Only a confirmed ref from the current outcome context; not needed for current_user_statement"),
  query: z.string().max(QUERY_MAX_LENGTH).optional().describe("Only in search: the name or purpose to find"),
  scope: z.enum(listScopes as [string, ...string[]]).optional().describe("Only in list: one memory scope"),
  sourceEntryRefs: z.array(z.string().regex(THREAD_ENTRY_REF_PATTERN)).min(1).max(20).optional()
    .describe("For complete: evidence refs only from read"),
  status: z.enum(STATUSES).optional().describe("Only in list: active or completed threads"),
  threadRef: z.string().regex(THREAD_REF_PATTERN).optional().describe("An opaque ref only from list, search or read"),
});

/** `listScopes` narrows the scope a list may name and `area` names whose threads they are. */
export function manageMemoryThreadPresentation(
  actions: readonly MemoryThreadAction[],
  options: { readonly area?: string; readonly listScopes?: readonly [string, ...string[]] } = {},
) {
  const [firstAction, ...otherActions] = actions;
  if (firstAction === undefined) throw new Error("manage_memory_thread requires at least one action");
  const changes = actions.some((action) => action === "complete" || action === "reactivate");
  const fields = FIELD_SCHEMAS(options.listScopes ?? LIST_SCOPES);
  const used = new Set(actions.flatMap((action) => ACTION_FIELDS[action]));
  const threads = options.area === undefined ? "Memory threads" : `Memory threads ${options.area}`;
  const reading = MEMORY_THREAD_READING_ACTIONS.filter((action) => actions.includes(action)).map((action) => READING_VERBS[action]);
  return {
    description: [
      changes
        ? `${threads} are long topics with history like a project, a goal or a move: work with them only through the listed operations.`
        : `${threads} are long topics with history like a project, a goal or a move: ${reading.join(", ")} them; here they can only be read.`,
      ...MEMORY_THREAD_ACTIONS.filter((action) => actions.includes(action)).map((action) => ACTION_DESCRIPTIONS[action]),
      "NOT_FOUND requires getting the threadRef again.",
    ].join(" "),
    // The fields are chosen per action at run time, so the static type names only what every call has.
    inputSchema: z.object({
      action: z.enum([firstAction, ...otherActions]),
      ...Object.fromEntries(Object.entries(fields).filter(([name]) => used.has(name))),
    }).strict() as unknown as z.ZodType<{ action: MemoryThreadAction } & Record<string, unknown>>,
  };
}

function inputError(message: string): never {
  return toolInputError(INPUT_ERROR_CODE, message);
}

function limitOf(input: Record<string, unknown>, fallback: number): number {
  const limit = input.limit ?? fallback;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > THREAD_HISTORY_PAGE_MAX_ENTRIES) {
    inputError(`Поле limit должно быть целым числом от 1 до ${THREAD_HISTORY_PAGE_MAX_ENTRIES}`);
  }
  return limit;
}

function refOf(input: Record<string, unknown>, key: string, pattern: RegExp, label: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !pattern.test(value)) inputError(`Поле ${key} должно быть ${label}`);
  return value;
}

function requireThreadRef(input: Record<string, unknown>): string {
  const threadRef = refOf(input, "threadRef", THREAD_REF_PATTERN, "threadRef из list, search или read");
  if (threadRef === undefined) inputError("Поле threadRef обязательно: возьмите его из list, search или read");
  return threadRef;
}

function requireInput(raw: unknown) {
  const input = requireInputRecord(raw, "manage_memory_thread", INPUT_ERROR_CODE);
  const action = input.action;
  if (typeof action !== "string" || !(MEMORY_THREAD_ACTIONS as readonly string[]).includes(action)) {
    inputError(`Для manage_memory_thread передайте action: ${MEMORY_THREAD_ACTIONS.join(" | ")}`);
  }
  const known = action as MemoryThreadAction;
  requireOnlyFields(input, ACTION_FIELDS[known], `action=${known}`, INPUT_ERROR_CODE);
  return { action: known, input };
}

function verifiedTurn(ctx: Parameters<typeof requireMemoryAuthorization>[0]) {
  const attributes = ctx.session.auth.current?.attributes;
  const conversationId = attributes?.telegramConversationId;
  const timelineEntryId = attributes?.telegramTimelineEntryId;
  if (typeof conversationId !== "string" || typeof timelineEntryId !== "string") {
    throw new AppError(
      "AGENT_MEMORY_THREAD_AUTHORITY_INVALID",
      "Не удалось подтвердить текущее сообщение для изменения нити памяти",
    );
  }
  return { conversationId, timelineEntryId };
}

async function readThreads(action: "list" | "read" | "search", input: Record<string, unknown>, ctx: Parameters<typeof requireMemoryAuthorization>[0]) {
  const auth = requireMemoryAuthorization(ctx);
  if (action === "list") {
    const cursor = refOf(input, "cursor", THREAD_REF_PATTERN, "nextCursor прошлой страницы нитей");
    const scope = optionalEnum(input, "scope", LIST_SCOPES, INPUT_ERROR_CODE);
    const status = optionalEnum(input, "status", STATUSES, INPUT_ERROR_CODE);
    return await memoryThreadQueryRepository.list(auth, {
      ...(cursor === undefined ? {} : { cursor }),
      limit: limitOf(input, LIST_DEFAULT_LIMIT),
      ...(scope === undefined ? {} : { scope }),
      ...(status === undefined ? {} : { status }),
    });
  }
  if (action === "search") {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (query === "" || query.length > QUERY_MAX_LENGTH) {
      inputError(`Поле query обязательно для search: название или цель нити, до ${QUERY_MAX_LENGTH} символов`);
    }
    return await memoryThreadQueryRepository.search(auth, query, limitOf(input, SEARCH_DEFAULT_LIMIT));
  }
  const cursor = refOf(input, "cursor", THREAD_ENTRY_REF_PATTERN, "nextCursor прошлой страницы записей нити");
  return await memoryThreadQueryRepository.read(auth, requireThreadRef(input), {
    ...(cursor === undefined ? {} : { cursor }),
    limit: limitOf(input, READ_DEFAULT_LIMIT),
  });
}

async function changeThread(action: "complete" | "reactivate", input: Record<string, unknown>, ctx: Parameters<typeof verifiedTurn>[0] & { callId: string }) {
  const auth = requireMemoryAuthorization(ctx);
  const threadRef = requireThreadRef(input);
  const turn = verifiedTurn(ctx);
  if (action === "reactivate") {
    return await memoryThreadLifecycleRepository.reactivate(auth, { operationKey: ctx.callId, threadRef, turn });
  }
  const authority = optionalEnum(input, "authority", AUTHORITIES, INPUT_ERROR_CODE);
  const sourceEntryRefs = input.sourceEntryRefs;
  if (!authority || !Array.isArray(sourceEntryRefs) || sourceEntryRefs.length === 0) {
    inputError("Для complete нужны authority и sourceEntryRefs");
  }
  if (sourceEntryRefs.length > 20 || sourceEntryRefs.some((ref) => typeof ref !== "string" || !THREAD_ENTRY_REF_PATTERN.test(ref))) {
    inputError("sourceEntryRefs — от 1 до 20 ссылок entry_… из read этой нити");
  }
  const outcomeRef = refOf(input, "outcomeRef", OUTCOME_REF_PATTERN, "подтверждённым outcomeRef");
  if ((authority !== "current_user_statement") !== (outcomeRef !== undefined)) {
    inputError("Подтверждённый outcomeRef обязателен только для confirmed_outcome");
  }
  return await memoryThreadLifecycleRepository.complete(auth, {
    authority: authority === "current_user_statement"
      ? { kind: "current_user_statement" as const }
      : { kind: "confirmed_outcome" as const, outcomeRef: outcomeRef! },
    operationKey: ctx.callId,
    sourceEntryRefs: sourceEntryRefs as string[],
    threadRef,
    turn,
  });
}

export default defineTool({
  // Repeating it after a crash is safe: reading changes nothing, a change is keyed on the call id.
  replaySafe: true,
  ...manageMemoryThreadPresentation(MEMORY_THREAD_ACTIONS),
  async execute(raw, ctx) {
    const { action, input } = requireInput(raw);
    return action === "complete" || action === "reactivate"
      ? await changeThread(action, input, ctx)
      : await readThreads(action, input, ctx);
  },
});
