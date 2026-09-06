/**
 * Model-facing memory tool result contract tests.
 *
 * Constructs covered:
 * - `remember`: persists the main agent's source-backed decision and optional atomic thread action.
 * - Tool results expose only opaque memory/thread refs and preserve immediate undo guidance.
 * - `list_memories`: projects internal records while preserving an opaque pagination cursor.
 * - `search_memories`: returns the already-safe retrieval DTO unchanged.
 * - `executeNonStreamingTool`: rejects an unexpected Eve streaming result before object assertions.
 */
import type { ToolContext, ToolDefinition } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const {
  createMemory,
  listMemories,
  logMemoryWriteEvent,
  resolveMemoryTurnSource,
  retrieveMemories,
} = vi.hoisted(() => ({
  createMemory: vi.fn(),
  listMemories: vi.fn(),
  logMemoryWriteEvent: vi.fn(),
  resolveMemoryTurnSource: vi.fn(),
  retrieveMemories: vi.fn(),
}));

vi.mock("./memory-context.js", () => ({
  requireMemoryAuthorization: () => ({ familyId: "family-1", scopes: ["personal"] }),
  requireWritableScope: (_authorization: unknown, scope: string) => scope,
}));
vi.mock("./memory-content-policy.js", () => ({
  requireAllowedMemoryContent: (content: string) => content,
}));
vi.mock("./memory-repository.js", () => ({
  memoryRepository: { create: createMemory, list: listMemories },
}));
vi.mock("./memory-retrieval.js", () => ({
  retrieveRelevantMemories: retrieveMemories,
}));
vi.mock("./memory-observability.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./memory-observability.js")>(),
  logMemoryWriteEvent,
}));
vi.mock("./memory-turn-source.js", () => ({
  resolveMemoryTurnSource,
}));
vi.mock("./session-auth.js", () => ({
  resolveSessionCaller: () => ({
    attributes: {
      telegramConversationId: "conversation-1",
      telegramTimelineEntryId: "timeline-entry-1",
    },
  }),
}));
import listMemoriesTool from "./tools/list_memories.js";
import remember from "./tools/remember.js";
import searchMemories from "./tools/search_memories.js";

const MEMORY_ID = "00000000-0000-4000-8000-000000000001";
const MEMORY_REF = "mem_0123456789abcdef0123456789abcdef";
const internalMemory = {
  author: { status: "current_member", telegramUserId: "7100000001", userId: "user-1" },
  confirmation: "user_confirmed",
  content: "Пользователь любит чай",
  createdAt: "2026-08-01T10:00:00.000Z",
  embeddingStatus: "pending",
  id: MEMORY_ID,
  kind: "preference",
  memoryRef: MEMORY_REF,
  messageThreadId: "42",
  scope: "personal",
  sensitivity: "normal",
  source: "eve:session-internal:turn-internal",
  // Запись менялась после создания, поэтому updatedAt обязан доехать до модели.
  updatedAt: "2026-08-02T11:30:00.000Z",
  sourceEvidence: {
    authorLabel: "Анна",
    kind: "reported",
    notice: "Сообщено другим участником; не является подтверждением субъекта.",
    observedAt: "2026-08-01T09:55:00.000Z",
  },
  thread: {
    action: "created" as const,
    threadRef: "thread_22222222222222222222222222222222",
  },
} as const;
const context = {
  callId: "call-1",
  session: {
    auth: { current: { attributes: { telegramChatType: "private" } } },
    id: "session-internal",
    turn: { id: "turn-internal" },
  },
} as unknown as ToolContext;

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    Symbol.asyncIterator in value;
}

async function executeNonStreamingTool<TInput, TOutput>(
  tool: Pick<ToolDefinition<TInput, TOutput>, "execute">,
  input: TInput,
  toolContext: ToolContext,
): Promise<TOutput> {
  // These contracts intentionally cover one final object, never Eve's streaming executor variant.
  const result = await tool.execute(input, toolContext);
  if (isAsyncIterable(result)) {
    throw new Error(
      "TEST_TOOL_RESULT_STREAMED_UNEXPECTEDLY: Ожидался единый object result, но tool вернул AsyncIterable",
    );
  }
  return result;
}

describe("model-facing memory tool results", () => {
  beforeEach(() => {
    createMemory.mockReset();
    listMemories.mockReset();
    resolveMemoryTurnSource.mockReset();
    resolveMemoryTurnSource.mockResolvedValue({
      conversationId: "conversation-1",
      isCurrent: true,
      messageThreadId: "42",
      sourceMessageId: "1001",
      timelineEntryId: "timeline-entry-1",
    });
    retrieveMemories.mockReset();
    logMemoryWriteEvent.mockReset();
  });

  it("persists an inferred sensitive memory without fabricating user confirmation", async () => {
    createMemory.mockResolvedValue(internalMemory);
    const input = {
      basis: "agent_inferred" as const,
      content: internalMemory.content,
      kind: "preference" as const,
      scope: "personal" as const,
      sensitivity: "sensitive" as const,
      subject: { kind: "current_author" as const },
    };

    await executeNonStreamingTool(remember, input, context);

    expect(createMemory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      confirmation: "model_high",
      sensitivity: "sensitive",
    }));
  });

  it("does not fabricate confirmation for an inferred private-to-family write", async () => {
    createMemory.mockResolvedValue(internalMemory);

    await executeNonStreamingTool(remember, {
      basis: "agent_inferred",
      content: internalMemory.content,
      kind: "preference",
      scope: "family",
      sensitivity: "normal",
      subject: { kind: "current_author" },
    }, context);

    expect(createMemory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      confirmation: "model_high",
      scope: "family",
    }));
  });

  it("rejects impossible thread identities before tool execution", () => {
    const schema = remember.inputSchema as z.ZodType;
    const input = {
      basis: "user_requested",
      content: "Начинаю отдельную длительную тему",
      kind: "fact",
      scope: "personal",
      sensitivity: "normal",
      subject: { kind: "current_author" },
      thread: {
        action: "create",
        purpose: "Сохранять цели и результаты",
        role: "goal",
        title: "Здоровье",
      },
    };

    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, subject: undefined }).success).toBe(false);
    const personalProject = schema.safeParse({
      ...input,
      subject: { kind: "none" },
      thread: { ...input.thread, identity: "project" },
    });
    const freeLabelThread = schema.safeParse({
      ...input,
      subject: { kind: "label", label: "Пух" },
      thread: { ...input.thread, identity: "subject" },
    });
    expect(personalProject.success).toBe(false);
    expect(freeLabelThread.success).toBe(false);
    if (!personalProject.success) {
      expect(personalProject.error.issues[0]!.message)
        .toContain("AGENT_MEMORY_THREAD_INPUT_INVALID");
    }
    if (!freeLabelThread.success) {
      expect(freeLabelThread.error.issues[0]!.message)
        .toContain("AGENT_MEMORY_THREAD_INPUT_INVALID");
    }
    expect(schema.safeParse({
      ...input,
      sensitivity: "sensitive",
      sourceSequence: "42",
    }).success).toBe(false);
  });

  it("returns only a safe item and opaque undo ref from remember", async () => {
    createMemory.mockResolvedValue(internalMemory);

    const result = await executeNonStreamingTool(remember, {
      basis: "agent_inferred",
      content: internalMemory.content,
      kind: "preference",
      scope: "personal",
      sensitivity: "normal",
      subject: {
        kind: "verified_ref",
        subjectRef: "subj_11111111111111111111111111111111",
      },
      thread: {
        action: "create",
        identity: "subject",
        purpose: "Сохранять предпочтения пользователя",
        role: "constraint",
        title: "Чай",
      },
    }, context);

    expect(result.item).toEqual({
      authorStatus: "current_member",
      confirmation: "user_confirmed",
      content: internalMemory.content,
      createdAt: internalMemory.createdAt,
      kind: "preference",
      memoryRef: MEMORY_REF,
      scope: "personal",
      sensitivity: "normal",
      updatedAt: internalMemory.updatedAt,
    });
    expect(result.thread).toEqual(internalMemory.thread);
    expect(JSON.stringify(result)).not.toContain(MEMORY_ID);
    expect(result.notice).toContain(`memoryRef ${MEMORY_REF}`);
    expect(createMemory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        confirmation: "model_high",
        explicitSource: {
          conversationId: "conversation-1",
          subject: {
            kind: "verified_ref",
            subjectRef: "subj_11111111111111111111111111111111",
          },
          timelineEntryId: "timeline-entry-1",
        },
        thread: {
          action: "create",
          identity: "subject",
          purpose: "Сохранять предпочтения пользователя",
          role: "constraint",
          title: "Чай",
        },
      }),
    );
    expect(logMemoryWriteEvent).toHaveBeenCalledWith(expect.objectContaining({
      code: "AGENT_MEMORY_WRITE_SUCCEEDED",
      sourceKind: "current",
      threadAction: "created",
    }));
  });

  it("selects one verified visible group-delta source by sequence", async () => {
    createMemory.mockResolvedValue(internalMemory);
    resolveMemoryTurnSource.mockResolvedValue({
      conversationId: "conversation-1",
      isCurrent: false,
      messageThreadId: "42",
      sourceMessageId: "1042",
      timelineEntryId: "timeline-entry-42",
    });

    await executeNonStreamingTool(remember, {
      basis: "agent_inferred",
      content: "Анна начала долгий проект",
      kind: "fact",
      scope: "group",
      sensitivity: "normal",
      sourceSequence: "42",
      subject: { kind: "current_author" },
      thread: {
        action: "create",
        identity: "subject",
        purpose: "Отслеживать развитие проекта и будущие результаты",
        role: "goal",
        title: "Проект Анны",
      },
    }, context);

    expect(resolveMemoryTurnSource).toHaveBeenCalledWith(
      context,
      expect.anything(),
      "42",
    );
    expect(createMemory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      confirmation: "model_high",
      explicitSource: {
        conversationId: "conversation-1",
        subject: { kind: "current_author" },
        timelineEntryId: "timeline-entry-42",
      },
      messageThreadId: "42",
      sourceEventId: "1042",
    }));
    expect(logMemoryWriteEvent).toHaveBeenCalledWith(expect.objectContaining({
      code: "AGENT_MEMORY_WRITE_SUCCEEDED",
      sourceKind: "delta",
    }));
  });

  it("logs a structured terminal remember failure without recording memory content", async () => {
    createMemory.mockRejectedValue(Object.assign(new Error("source missing"), {
      code: "AGENT_MEMORY_EXPLICIT_SOURCE_INVALID",
    }));

    await expect(executeNonStreamingTool(remember, {
      basis: "agent_inferred",
      content: "Не записывать в диагностический лог",
      kind: "fact",
      scope: "personal",
      sensitivity: "normal",
      subject: { kind: "current_author" },
    }, context)).rejects.toThrow("source missing");

    expect(logMemoryWriteEvent).toHaveBeenCalledWith({
      code: "AGENT_MEMORY_WRITE_FAILED",
      errorCode: "AGENT_MEMORY_EXPLICIT_SOURCE_INVALID",
      scope: "personal",
      sourceKind: "current",
      threadAction: "none",
    });
    expect(JSON.stringify(logMemoryWriteEvent.mock.calls)).not.toContain("Не записывать");
  });

  it("returns only safe list items and keeps the repository cursor", async () => {
    listMemories.mockResolvedValue({ items: [internalMemory], nextCursor: "opaque-cursor" });

    const result = await executeNonStreamingTool(listMemoriesTool, { limit: 20 }, context);

    expect(result).toEqual({
      items: [{
        authorStatus: "current_member",
        confirmation: "user_confirmed",
        content: internalMemory.content,
        createdAt: internalMemory.createdAt,
        evidence: internalMemory.sourceEvidence,
        kind: "preference",
        memoryRef: MEMORY_REF,
        scope: "personal",
        sensitivity: "normal",
        updatedAt: internalMemory.updatedAt,
      }],
      nextCursor: "opaque-cursor",
    });
    expect(JSON.stringify(result)).not.toMatch(/user-1|7100000001|session-internal|turn-internal/u);
  });

  it("returns only the safe retrieval DTO from search_memories", async () => {
    const safeMemory = {
      authorStatus: "current_member",
      confirmation: "user_confirmed",
      content: internalMemory.content,
      createdAt: internalMemory.createdAt,
      kind: "preference",
      memoryRef: MEMORY_REF,
      scope: "personal",
      sensitivity: "normal",
      updatedAt: internalMemory.updatedAt,
    };
    retrieveMemories.mockResolvedValue([safeMemory]);

    await expect(executeNonStreamingTool(searchMemories, { query: "чай" }, context))
      .resolves.toEqual([safeMemory]);
    expect(JSON.stringify(await retrieveMemories.mock.results[0]!.value)).not.toContain(MEMORY_ID);
  });

  it("records an explicit search without logging its query or result text", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const found = [{ memoryRef: MEMORY_REF, content: "Частный факт" }];
    retrieveMemories.mockResolvedValue(found);
    try {
      await executeNonStreamingTool(searchMemories, { query: "Частный запрос" }, context);
      expect(JSON.parse(info.mock.calls[0]![0] as string)).toMatchObject({
        code: "AGENT_MEMORY_SEARCH_METRICS", sessionId: context.session.id,
        turnId: context.session.turn.id, callId: context.callId, outcome: "succeeded",
        memoryRefs: [MEMORY_REF], memoryCharacters: "Частный факт".length,
      });
      expect(JSON.stringify(info.mock.calls)).not.toMatch(/Частный запрос|Частный факт/u);
    } finally { info.mockRestore(); }
  });

  it("does not present a failed search as an empty successful result or retry it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const failure = new Error("unavailable");
    retrieveMemories.mockRejectedValue(failure);
    try {
      await expect(executeNonStreamingTool(searchMemories, { query: "Частный запрос" }, context))
        .rejects.toBe(failure);
      expect(retrieveMemories).toHaveBeenCalledTimes(1);
      expect(JSON.parse(info.mock.calls[0]![0] as string)).toMatchObject({
        outcome: "failed", memoryRefs: null, memoryCharacters: null,
      });
    } finally { info.mockRestore(); }
  });
});
