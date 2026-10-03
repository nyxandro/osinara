/**
 * Expired approval presentation tests.
 *
 * Constructs covered:
 * - `timedOutPromptText`: states the timeout and that the action did not run.
 * - `createTimedOutPromptFinalizer`: surfaces a rejected Telegram edit as a stable failure.
 */
import { describe, expect, it, vi } from "vitest";

import { buildApprovalMessage } from "./approval-message.js";
import {
  createTimedOutPromptFinalizer,
  timedOutPromptEditBody,
  timedOutPromptText,
} from "./approval-timeout-prompt.js";
import type { TimedOutApprovalClaim } from "./approval-timeout.js";

const CLAIM: TimedOutApprovalClaim = {
  applicationSessionId: "app-session-1",
  auth: { attributes: {}, authenticator: "telegram", principalId: "user-1", principalType: "user" } as never,
  kind: "tool-approval",
  agentSessionId: "wrun_parked",
  id: "approval-1",
  leaseToken: "lease-1",
  promptText: "Подтвердите действие: исправить запись в памяти.",
  requestId: "aitxt-request-1",
  telegramChatId: "649624756",
  telegramMessageId: "2801",
  toolName: "manage_memory",
};

describe("timedOutPromptText", () => {
  it("keeps the original prompt and states that nothing was executed", () => {
    const text = timedOutPromptText(CLAIM.promptText);
    expect(text).toContain(CLAIM.promptText);
    expect(text).toContain("Время на подтверждение истекло.");
    expect(text).toContain("Действие не выполнено.");
  });

  it("does not keep promising an execution next to the expiry", () => {
    // Сквозная проверка исправляемого бага: реальное собранное окно, а не строка без последствия.
    const composed = buildApprovalMessage({
      actionLabel: "исправить запись в памяти",
      facts: ["Тип памяти: episode"],
    });
    expect(composed).toContain("будет выполнено один раз");

    const text = timedOutPromptText(composed);
    expect(text).not.toContain("будет выполнено один раз");
    expect(text).toContain("Действие не выполнено.");
    expect(text).toContain("Тип памяти: episode");
  });

  it("truncates an oversized prompt within the Telegram message limit", () => {
    const text = timedOutPromptText("я".repeat(6_000));
    expect(text.length).toBeLessThanOrEqual(4_096);
    expect(text).toContain("Действие не выполнено.");
  });
});

describe("createTimedOutPromptFinalizer", () => {
  it("clears the keyboard of the exact prompt message", async () => {
    const editMessage = vi.fn().mockResolvedValue({ ok: true });
    await createTimedOutPromptFinalizer(editMessage)(CLAIM);
    expect(editMessage).toHaveBeenCalledWith({
      chat_id: "649624756",
      message_id: 2801,
      reply_markup: { inline_keyboard: [] },
      text: timedOutPromptText(CLAIM.promptText),
    });
  });

  it("builds a Telegram payload that removes the stale buttons", () => {
    const body = timedOutPromptEditBody(CLAIM);
    expect(body.reply_markup).toEqual({ inline_keyboard: [] });
    expect(body.message_id).toBe(2801);
    expect(typeof body.message_id).toBe("number");
  });

  it("fails with a stable code when Telegram rejects the edit", async () => {
    const editMessage = vi.fn().mockResolvedValue({ ok: false });
    await expect(createTimedOutPromptFinalizer(editMessage)(CLAIM)).rejects.toThrow(
      /AGENT_APPROVAL_TIMEOUT_PROMPT_EDIT_REJECTED/u,
    );
  });
});
