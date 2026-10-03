/**
 * Consolidated memory mutation routing tests.
 *
 * Constructs:
 * - `manage_memory.edit`: passes an opaque ref to the scoped repository boundary.
 * - Delete and provenance-bound undo use distinct opaque-ref repository boundaries.
 * - Raw database UUIDs and the historical `id` field are rejected at the model boundary.
 * - Approval and execution share one strict action parser without requiring persisted HITL evidence.
 */
import type { ToolContext } from "../runtime/tool.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const {
  canUndoMemory,
  deleteMemoryByRef,
  undoMemory,
  updateMemoryByRef,
} = vi.hoisted(() => ({
  canUndoMemory: vi.fn(),
  deleteMemoryByRef: vi.fn(),
  undoMemory: vi.fn(),
  updateMemoryByRef: vi.fn(),
}));

vi.mock("./memory-context.js", () => ({
  requireMemoryAuthorization: () => ({ familyId: "family-1", scopes: ["personal"] }),
}));
vi.mock("./memory-repository.js", () => ({
  memoryRepository: {
    canUndoCreate: canUndoMemory,
    deleteByRef: deleteMemoryByRef,
    undoCreate: undoMemory,
    updateByRef: updateMemoryByRef,
  },
}));
import manageMemory from "./tools/manage_memory.js";

const MEMORY_REF = "mem_0123456789abcdef0123456789abcdef";
const context = {
  callId: "call-1",
  session: {
    auth: {
      current: {
        attributes: {
          telegramChatType: "private",
          telegramConversationId: "conversation-1",
          telegramTimelineEntryId: "timeline-entry-1",
        },
        principalId: "user-1",
        principalType: "user",
      },
    },
    id: "session-1",
    turn: { id: "turn-1" },
  },
} as unknown as ToolContext;

function approvalFor(input: Record<string, unknown>, chatType = "private") {
  const approval = manageMemory.approval as (context: never) => unknown;
  return approval({
    approvedTools: new Set(),
    callId: "call-1",
    session: {
      ...context.session,
      auth: {
        current: {
          attributes: {
            telegramChatType: chatType,
            telegramConversationId: "conversation-1",
            telegramTimelineEntryId: "timeline-entry-1",
          },
          principalId: "user-1",
          principalType: "user",
        },
      },
    },
    toolInput: input,
    toolName: "manage_memory",
  } as never);
}

describe("manage_memory", () => {
  beforeEach(() => {
    canUndoMemory.mockReset();
    deleteMemoryByRef.mockReset();
    undoMemory.mockReset();
    updateMemoryByRef.mockReset();
  });

  it("requires a published action enum in the model schema", () => {
    const schema = z.toJSONSchema(manageMemory.inputSchema as z.ZodType) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(schema.required).toContain("action");
    expect(schema.properties?.action).toMatchObject({ enum: ["edit", "delete", "undo"] });
  });

  it("tells the model that edit is a complete integrity-preserving replacement", () => {
    expect(manageMemory.description).toContain("полную новую версию записи");
    expect(manageMemory.description).toContain("сохранив все актуальные детали");
    expect(manageMemory.description).toContain("не выполняй необоснованную мутацию");
  });

  it("rejects malformed edit before showing private approval", async () => {
    await expect(approvalFor({ action: "edit", memoryRef: MEMORY_REF })).rejects.toThrowError(
      /AGENT_MEMORY_INPUT_INVALID: Поле content обязательно/u,
    );
    expect(canUndoMemory).not.toHaveBeenCalled();
  });

  it.each(["edit", "delete"] as const)("does not confirm %s with the user", async (action) => {
    const input = action === "edit"
      ? { action, content: "Исправлено", memoryRef: MEMORY_REF }
      : { action, memoryRef: MEMORY_REF };

    // Решение о фактах принимает агент; страховкой служит мягкое удаление, а не окно подтверждения.
    await expect(approvalFor(input)).resolves.toBe("not-applicable");
  });

  it("allows undo without HITL only when repository proves immediate provenance", async () => {
    canUndoMemory.mockResolvedValue(true);

    await expect(approvalFor({ action: "undo", memoryRef: MEMORY_REF }))
      .resolves.toBe("not-applicable");
    expect(canUndoMemory).toHaveBeenCalledWith(
      { familyId: "family-1", scopes: ["personal"] },
      MEMORY_REF,
      { sessionId: "session-1", turnId: "turn-1" },
    );
  });

  it("explicitly denies undo when durable provenance is not proven", async () => {
    canUndoMemory.mockResolvedValue(false);

    await expect(approvalFor({ action: "undo", memoryRef: MEMORY_REF }, "supergroup"))
      .resolves.toMatchObject({
      type: "denied",
      reason: expect.stringMatching(/^AGENT_MEMORY_UNDO_DENIED:/u),
    });
  });

  it("passes only repository fields for an edit", async () => {
    updateMemoryByRef.mockResolvedValue({
      author: { status: "current_member", telegramUserId: null, userId: "user-1" },
      confirmation: "user_confirmed",
      content: "Исправлено",
      createdAt: "2026-08-01T10:00:00.000Z",
      embeddingStatus: "pending",
      id: "00000000-0000-4000-8000-000000000001",
      kind: "fact",
      memoryRef: MEMORY_REF,
      messageThreadId: null,
      scope: "personal",
      sensitivity: "normal",
      source: "eve:private-session:turn-1",
      updatedAt: "2026-08-01T11:00:00.000Z",
    });

    const result = await manageMemory.execute(
      { action: "edit", content: "Исправлено", memoryRef: MEMORY_REF },
      context,
    );

    expect(updateMemoryByRef).toHaveBeenCalledWith(
      { familyId: "family-1", scopes: ["personal"] },
      {
        content: "Исправлено",
        memoryRef: MEMORY_REF,
        operationKey: "call-1",
        source: { conversationId: "conversation-1", timelineEntryId: "timeline-entry-1" },
      },
    );
    expect(result).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("source");
  });

  it("routes delete through idempotent deletion", async () => {
    deleteMemoryByRef.mockResolvedValue({ deleted: true });

    await manageMemory.execute({ action: "delete", memoryRef: MEMORY_REF }, context);

    expect(deleteMemoryByRef).toHaveBeenCalledWith(
      { familyId: "family-1", scopes: ["personal"] },
      MEMORY_REF,
      "call-1",
    );
  });

  it.each([
    { action: "delete" as const, id: "00000000-0000-4000-8000-000000000001" },
    { action: "delete" as const, memoryRef: "00000000-0000-4000-8000-000000000001" },
  ])("rejects raw memory UUID payloads: $action", async (input) => {
    await expect(manageMemory.execute(input, context)).rejects.toThrowError(
      /AGENT_MEMORY_INPUT_INVALID/,
    );
    expect(deleteMemoryByRef).not.toHaveBeenCalled();
  });

  it("routes undo through the provenance-enforcing repository boundary", async () => {
    undoMemory.mockResolvedValue({ deleted: true });

    await manageMemory.execute({ action: "undo", memoryRef: MEMORY_REF }, context);

    expect(undoMemory).toHaveBeenCalledWith(
      { familyId: "family-1", scopes: ["personal"] },
      MEMORY_REF,
      {
        operationKey: "call-1",
        sessionId: "session-1",
        turnId: "turn-1",
      },
    );
    expect(deleteMemoryByRef).not.toHaveBeenCalled();
  });
});
