/**
 * Tool delivery history tests.
 *
 * Constructs covered:
 * - A group delivery is recorded in the group journal and bound to a reply route.
 * - A private delivery is recorded only when it stands for the answer itself.
 * - Once Telegram has confirmed the message, no history failure is thrown, not even a missing
 *   conversation context: an error there would read as an unsent message and invite a duplicate.
 */
import type { ToolContext } from "../runtime/tool.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const repositories = vi.hoisted(() => ({
  conversation: vi.fn(),
  group: vi.fn(),
  routes: vi.fn(),
}));

vi.mock("./conversation-timeline-repository.js", () => ({
  conversationTimelineRepository: { recordAgentResponse: repositories.conversation },
}));
vi.mock("./telegram-group-journal-repository.js", () => ({
  telegramGroupJournalRepository: { recordAgentResponse: repositories.group },
}));
vi.mock("./sessions/session-context.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./sessions/session-context.js")>(),
  registerTelegramMessageRoutes: repositories.routes,
}));

import {
  recordToolDeliveryInTimeline,
  toolDeliveryTimelineTarget,
} from "./telegram-tool-delivery-timeline.js";

function context(attributes: Record<string, string>): ToolContext {
  return {
    session: {
      auth: {
        current: {
          attributes: { familyId: "family-1", role: "owner", ...attributes },
          authenticator: "telegram",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
    },
  } as unknown as ToolContext;
}

const GROUP = {
  applicationSessionId: "app-session-1",
  groupId: "group-1",
  groupType: "family_private",
  telegramChatId: "-1001",
  telegramChatType: "supergroup",
  telegramForumTopicId: "7",
  telegramMessageThreadId: "7",
  telegramTimelineEntryId: "entry-41",
};
const PRIVATE = {
  applicationSessionId: "app-session-2",
  telegramChatId: "101",
  telegramChatType: "private",
  telegramConversationId: "conversation-1",
};
const DELIVERY = {
  contentText: "Гифка: кот закатывает глаза",
  failureCode: "AGENT_GIF_PROJECTION_FAILED",
  replacesAnswer: true,
  telegramMessageId: "93",
};

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("tool delivery history", () => {
  it("records a group delivery in its topic and binds the reply route", async () => {
    const ctx = context(GROUP);

    await expect(recordToolDeliveryInTimeline(ctx, toolDeliveryTimelineTarget(ctx), DELIVERY)).resolves.toBe(true);

    expect(repositories.group).toHaveBeenCalledWith(expect.objectContaining({
      applicationSessionId: "app-session-1",
      contentText: "Гифка: кот закатывает глаза",
      groupId: "group-1",
      messageThreadId: "7",
      replyToEntryId: "entry-41",
      telegramMessageIds: ["93"],
    }));
    expect(repositories.routes).toHaveBeenCalledWith({
      applicationSessionId: "app-session-1",
      chatId: "-1001",
      messageIds: ["93"],
      messageThreadId: 7,
    });
  });

  it("records a private delivery only when it stands for the answer", async () => {
    const ctx = context(PRIVATE);

    await recordToolDeliveryInTimeline(ctx, toolDeliveryTimelineTarget(ctx), { ...DELIVERY, replacesAnswer: false });
    expect(repositories.conversation).not.toHaveBeenCalled();

    await recordToolDeliveryInTimeline(ctx, toolDeliveryTimelineTarget(ctx), DELIVERY);
    expect(repositories.conversation).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conversation-1",
      telegramMessageIds: ["93"],
    }));
  });

  it("reports a missing conversation context after delivery instead of throwing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { applicationSessionId: _missing, ...withoutSession } = GROUP;
    const ctx = context(withoutSession);

    await expect(recordToolDeliveryInTimeline(ctx, toolDeliveryTimelineTarget(ctx), DELIVERY)).resolves.toBe(false);

    expect(repositories.group).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({
      code: "AGENT_GIF_PROJECTION_FAILED",
      telegramMessageId: "93",
    });
  });
});
