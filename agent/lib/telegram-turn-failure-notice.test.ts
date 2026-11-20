/**
 * A person whose message got no answer learns it in the chat (#561).
 *
 * Constructs covered:
 * - Only a turn a person's Telegram message started gets the notice, with the failure's code.
 * - No notice for lost access, nor in the owner's own private chat, where the owner's failure notice says it.
 * - The notice goes through the turn's final-delivery outbox and replies to the person's message.
 * - A notice that cannot go is logged; it never fails the turn's cleanup.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const delivery = vi.hoisted(() => ({ deliver: vi.fn(), hasDelivery: vi.fn(), post: vi.fn(), startedAnyCall: vi.fn() }));
vi.mock("./telegram-final-delivery.js", () => ({ deliverTelegramFinalOutput: delivery.deliver }));
vi.mock("./telegram-final-delivery-repository.js", () => ({
  telegramFinalDeliveryRepository: { hasDelivery: delivery.hasDelivery, startedAnyCall: delivery.startedAnyCall },
}));
vi.mock("./telegram-presentation-post.js", () => ({ postTelegramPresentationChunk: delivery.post }));

import { noticeFailedTurn } from "./telegram-turn-failure-notice.js";

function context(attributes: Record<string, unknown>) {
  return {
    session: {
      auth: { current: { attributes, authenticator: "telegram", principalId: "user-1", principalType: "user" }, initiator: null },
      id: "wrun_session",
      turn: { id: "turn_one" },
    },
  } as never;
}

const MEMBER_IN_GROUP = {
  osinaraTelegramUpdateId: "1001", role: "member", telegramChatId: "-100200", telegramChatType: "supergroup",
  telegramReplyToMessageId: "55",
};
const channel = { state: { chatId: "-100200", chatType: "supergroup" }, telegram: { chatId: "-100200" } } as never;

describe("failed turn notice", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delivery.deliver.mockResolvedValue([]);
    delivery.hasDelivery.mockResolvedValue(false);
    delivery.startedAnyCall.mockResolvedValue(false);
  });

  it("tells the person in the chat, with the failure's code, once through the turn's outbox", async () => {
    await noticeFailedTurn({ applicationSessionId: "app-1", channel, code: "AGENT_MODEL_TEMPORARILY_UNAVAILABLE", ctx: context(MEMBER_IN_GROUP) });

    expect(delivery.deliver).toHaveBeenCalledTimes(1);
    const input = delivery.deliver.mock.calls[0]![0];
    expect(input).toMatchObject({ agentSessionId: "wrun_session", agentTurnId: "turn_one", applicationSessionId: "app-1", replyButtons: false });
    expect(input.answer.markdown).toMatch(/^Не получилось ответить/u);
    expect(input.answer.markdown).toContain("AGENT_MODEL_TEMPORARILY_UNAVAILABLE");
    expect(input.answer.markdown).toContain("Попробуйте написать ещё раз");
    expect(delivery.hasDelivery).toHaveBeenCalledWith("wrun_session", "turn_one");
    await input.sendChunk({ format: "plain", media: [], text: input.answer.markdown }, 0, true);
    expect(delivery.post).toHaveBeenCalledWith(expect.objectContaining({ text: input.answer.markdown }), channel,
      { allow_sending_without_reply: true, message_id: 55 });
  });

  it.each([
    ["a turn no person's message started", { ...MEMBER_IN_GROUP, osinaraTelegramUpdateId: undefined }, "AGENT_MODEL_FAILED"],
    ["lost access", MEMBER_IN_GROUP, "AGENT_TURN_ACCESS_REVOKED"],
    ["the owner's own private chat", { ...MEMBER_IN_GROUP, role: "owner", telegramChatType: "private" }, "AGENT_MODEL_FAILED"],
  ])("stays silent for %s", async (_case, attributes, code) => {
    await noticeFailedTurn({ applicationSessionId: "app-1", channel, code, ctx: context(attributes) });

    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it("stays silent when the turn's own answer had begun going out", async () => {
    delivery.hasDelivery.mockResolvedValue(true);

    await noticeFailedTurn({ applicationSessionId: "app-1", channel, code: "AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_FAILED", ctx: context(MEMBER_IN_GROUP) });

    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  // An action may have landed before the failure; a blind repeat could do it twice.
  it("asks to check the result before repeating when the turn had started an action", async () => {
    delivery.startedAnyCall.mockResolvedValue(true);

    await noticeFailedTurn({ applicationSessionId: "app-1", channel, code: "AGENT_MODEL_FAILED", ctx: context(MEMBER_IN_GROUP) });

    expect(delivery.startedAnyCall).toHaveBeenCalledWith("turn_one");
    expect(delivery.deliver.mock.calls[0]![0].answer.markdown).toContain("проверьте результат, прежде чем повторять");
  });

  it("speaks to the owner in a group, where no owner notice reaches the others", async () => {
    await noticeFailedTurn({ applicationSessionId: "app-1", channel, code: "AGENT_MODEL_FAILED", ctx: context({ ...MEMBER_IN_GROUP, role: "owner" }) });

    expect(delivery.deliver).toHaveBeenCalledTimes(1);
  });

  it("logs a notice that cannot go instead of failing the turn's cleanup", async () => {
    delivery.deliver.mockRejectedValue(new Error("telegram down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(noticeFailedTurn({ applicationSessionId: "app-1", channel, code: "AGENT_MODEL_FAILED", ctx: context(MEMBER_IN_GROUP) }))
      .resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledWith(expect.stringContaining("AGENT_TURN_FAILURE_NOTICE_FAILED"));
    logged.mockRestore();
  });
});
