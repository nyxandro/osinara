/**
 * Memory tool approval policy regression tests.
 *
 * Constructs covered:
 * - Sensitive and private-to-family writes require confirmation.
 * - Group corrections avoid unsafe callback identity reuse and rely on repository author checks.
 */
import { describe, expect, it } from "vitest";

import manageMemory from "../tools/manage_memory.js";
import remember from "../tools/remember.js";

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
  it("requires approval for sensitive writes and private family disclosure", () => {
    expect(approvalFor(remember, { scope: "personal", sensitivity: "sensitive" }, "private"))
      .toBe("user-approval");
    expect(approvalFor(remember, { scope: "family", sensitivity: "normal" }, "private"))
      .toBe("user-approval");
    expect(approvalFor(remember, { scope: "group", sensitivity: "normal" }, "group"))
      .toBe("not-applicable");
  });

  it("confirms private mutations but executes addressed group mutations under SQL author checks", () => {
    expect(approvalFor(manageMemory, { action: "delete" }, "private")).toBe("user-approval");
    expect(approvalFor(manageMemory, { action: "edit" }, "supergroup")).toBe("not-applicable");
    expect(approvalFor(manageMemory, { action: "undo" }, "private")).toBe("not-applicable");
  });
});
