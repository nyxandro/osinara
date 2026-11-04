/**
 * Memory tool approval policy regression tests.
 *
 * Constructs covered:
 * - Работа с фактами подтверждения не запрашивает: решение принимает агент, а страховкой служит
 *   мягкое удаление. Публичный чат не получает окна подтверждения памяти вовсе.
 * - Отмена создания остаётся под политикой прав: без доказанного provenance она отклоняется.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { canUndoCreate, reactivateThread } = vi.hoisted(() => ({
  canUndoCreate: vi.fn(),
  reactivateThread: vi.fn(),
}));

const requireMemoryAuthorization = vi.hoisted(() => vi.fn(() => ({ familyId: "family-1", scopes: ["personal"] })));
vi.mock("./memory-context.js", () => ({
  requireMemoryAuthorization,
  requireWritableScope: (_authorization: unknown, scope: unknown) => scope,
}));
vi.mock("./memory-repository.js", () => ({
  memoryRepository: {
    canUndoCreate,
    create: vi.fn(),
    deleteByRef: vi.fn(),
    undoCreate: vi.fn(),
    updateByRef: vi.fn(),
  },
}));
vi.mock("./memory-thread-lifecycle-repository.js", () => ({
  memoryThreadLifecycleRepository: {
    complete: vi.fn(),
    reactivate: reactivateThread,
  },
}));

import manageMemory from "./tools/manage_memory.js";
import manageMemoryThread from "./tools/manage_memory_thread.js";
import remember from "./tools/remember.js";

function approvalFor(tool: unknown, input: Record<string, unknown>, chatType: string) {
  const approval = (tool as { approval: (context: unknown) => unknown }).approval;
  return approval({
    approvedTools: [],
    callId: "call-1",
    session: {
      auth: {
        current: {
          attributes: { telegramChatType: chatType },
          principalId: "user-1",
          principalType: "user",
        },
      },
      id: "session-1",
      turn: { id: "turn-1" },
    },
    toolInput: input,
    toolName: "memory-tool",
  });
}

describe("memory tool approvals", () => {
  beforeEach(() => {
    canUndoCreate.mockReset();
    reactivateThread.mockReset();
  });

  it("never asks the user to confirm remembering a fact", () => {
    // Политика снята целиком: даже sensitive-запись и раскрытие из лички в семейную область
    // больше не рисуют окно подтверждения.
    expect((remember as { approval?: unknown }).approval).toBeUndefined();
  });

  it("never asks the user to confirm a memory mutation", async () => {
    const memoryRef = "mem_0123456789abcdef0123456789abcdef";
    for (const chatType of ["private", "supergroup"]) {
      expect(await approvalFor(manageMemory, { action: "delete", memoryRef }, chatType))
        .toBe("not-applicable");
      expect(await approvalFor(
        manageMemory,
        { action: "edit", content: "Исправлено", memoryRef },
        chatType,
      )).toBe("not-applicable");
    }
  });

  it("lets the list through without a confirmation and without checking memory access at that step", async () => {
    // A failure of that check here would end the turn; execution checks access itself and answers the model.
    requireMemoryAuthorization.mockClear();
    expect(await approvalFor(manageMemory, { action: "list" }, "private")).toBe("not-applicable");
    expect(requireMemoryAuthorization).not.toHaveBeenCalled();
  });

  it("lets a malformed call reach execution, whose own check answers it, instead of ending the turn", async () => {
    // Thrown in the approval step, an input refusal would end the turn instead of reaching the model; since the
    // list became an action of this tool (#457) one schema carries the fields of every action.
    const memoryRef = "mem_0123456789abcdef0123456789abcdef";
    for (const input of [
      { action: "list", memoryRef },
      { action: "edit", limit: 20, memoryRef },
      { action: "delete" },
    ]) {
      expect(await approvalFor(manageMemory, input, "private"), JSON.stringify(input)).toBe("not-applicable");
    }
  });

  it("still refuses an undo without durable provenance", async () => {
    const memoryRef = "mem_0123456789abcdef0123456789abcdef";
    canUndoCreate.mockResolvedValue(true);
    expect(await approvalFor(manageMemory, { action: "undo", memoryRef }, "private"))
      .toBe("not-applicable");

    // Это проверка прав, а не вопрос пользователю, поэтому она сохраняется.
    canUndoCreate.mockResolvedValue(false);
    expect(await approvalFor(manageMemory, { action: "undo", memoryRef }, "private"))
      .toMatchObject({ type: "denied" });
  });

  it("does not gate thread lifecycle behind a confirmation", () => {
    expect((manageMemoryThread as { approval?: unknown }).approval).toBeUndefined();
  });

  it("executes thread lifecycle without persisted approval evidence", async () => {
    reactivateThread.mockResolvedValue({ status: "active" });
    const context = {
      callId: "call-1",
      session: {
        auth: {
          current: {
            attributes: {
              telegramConversationId: "conversation-1",
              telegramTimelineEntryId: "timeline-entry-1",
            },
          },
        },
      },
    } as never;

    await manageMemoryThread.execute({
      action: "reactivate",
      threadRef: "thread_0123456789abcdef0123456789abcdef",
    }, context);

    expect(reactivateThread).toHaveBeenCalledOnce();
  });
});
