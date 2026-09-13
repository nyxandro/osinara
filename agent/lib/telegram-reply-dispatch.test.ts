/**
 * Real Eve Telegram dispatch with the application reply-authorization boundary.
 * Ordinary conversation must use send, never a synthetic response to another bot.
 */
import { telegramChannel } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { createTelegramMessageHandler } from "./telegram-on-message.js";
import { BOT_USERNAME, repositories } from "./telegram-on-message.test-fixtures.js";

interface HttpRoute {
  handler(request: Request, context: Record<string, unknown>): Promise<Response>;
}

describe("Telegram reply dispatch", () => {
  it.each([
    { actor: "human", addressed: true, target: "other", authorization: "not_applicable", dispatch: "send" },
    { actor: "bot", addressed: true, target: "other", authorization: "not_applicable", dispatch: "send" },
    { actor: "channel", addressed: true, target: "other", authorization: "not_applicable", dispatch: "send" },
    { actor: "human", addressed: false, target: "other", authorization: "not_applicable", dispatch: "none" },
    { actor: "human", addressed: true, target: "osinara", authorization: "authorized", dispatch: "respond" },
    { actor: "human", addressed: true, target: "osinara", authorization: "forbidden", dispatch: "none" },
    { actor: "human", addressed: true, target: "osinara", authorization: "expired", dispatch: "none" },
  ] as const)(
    "$actor reply to $target, addressed=$addressed, authorization=$authorization uses $dispatch",
    async ({ actor, addressed, target, authorization, dispatch }) => {
      const repository = repositories();
      repository.telegram.findGroup.mockResolvedValue({
        familyId: "family-1",
        groupId: "group-1",
        messageMode: "addressed_only",
        skillAllowlist: [],
        telegramChatId: "-100",
        toolAllowlist: [],
        type: "external",
      });
      repository.hitl.authorizeReply.mockResolvedValue(authorization);
      repository.session.prepareTurn.mockResolvedValue({
        continuationToken: "osinara:group:group-1:main:osinara:1",
        generation: 1,
        id: "session-1",
        rotated: false,
        sandboxSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      });
      const text = addressed ? `@${BOT_USERNAME} а ты что затихла?` : "ответ другому боту";
      const durableMessage = `<current_telegram_message>${text}</current_telegram_message>`;
      repository.groupContext.prepare.mockResolvedValue({
        cursorSequence: "1",
        durableMessage,
        currentMessageEnvelope: durableMessage,
        omittedBeforeSequence: null,
        timelineOmission: null,
        visibleEntryIds: ["00000000-0000-4000-8000-000000000010"],
        visibleTimelineEntries: [],
      });
      const send = vi.fn().mockResolvedValue({ id: "eve-session-1" });
      const respond = vi.fn().mockResolvedValue({ id: "eve-session-1" });
      const from = vi.fn(() => ({ send, respond }));
      const channel = telegramChannel({
        botUsername: BOT_USERNAME,
        credentials: { webhookSecretToken: "webhook-secret" },
        onMessage: (context,message) => createTelegramMessageHandler(repository)({ ...context,
          ingressRecovery: { updateId: "1001",dispatchId: "123e4567-e89b-42d3-a456-426614174000" } },message),
      });
      const route = channel.routes[0] as unknown as HttpRoute;
      let backgroundTask: Promise<unknown> | undefined;

      const response = await route.handler(new Request("https://agent.example/eve/v1/telegram", {
        body: JSON.stringify({
          message: {
            chat: { id: -100, type: "supergroup" },
            date: 1_700_000_000,
            from: {
              first_name: "Sender",
              id: actor === "channel" ? 136_817_688 : 101,
              is_bot: actor !== "human",
            },
            ...(actor === "channel" ? {
              sender_chat: { id: -200, title: "Channel", type: "channel" },
            } : {}),
            message_id: 3496,
            reply_to_message: {
              chat: { id: -100, type: "supergroup" },
              date: 1_699_999_999,
              from: {
                first_name: "Bot",
                id: 999,
                is_bot: true,
                username: target === "osinara" ? BOT_USERNAME : "mimimia_ai_bot",
              },
              message_id: 3493,
              text: "Previous message",
            },
            text,
          },
          update_id: 1001,
        }),
        headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
        method: "POST",
      }), {
        params: {},
        requestIp: null,
        from,
        waitUntil(task: Promise<unknown>) {
          backgroundTask = task;
        },
      });
      await backgroundTask;

      expect(response.status).toBe(200);
      expect(send).toHaveBeenCalledTimes(dispatch === "send" ? 1 : 0);
      expect(respond).toHaveBeenCalledTimes(dispatch === "respond" ? 1 : 0);
      if (dispatch === "send") {
        expect(send).toHaveBeenCalledWith(durableMessage, expect.objectContaining({
          auth: expect.objectContaining({
            attributes: expect.objectContaining({ memoryScopes: ["group"] }),
          }),
        }));
        expect(repository.session.prepareTurn).toHaveBeenCalledWith(expect.objectContaining({
          baseContinuationToken: "osinara:group:group-1:main",
          kind: "canonical",
        }));
      } else if (dispatch === "respond") {
        expect(respond).toHaveBeenCalledWith([
          { requestId: "telegram_reply:3493", text },
        ], expect.anything());
        expect(repository.session.prepareAuthorizedResponse).toHaveBeenCalledWith(expect.objectContaining({
          ingress: expect.objectContaining({ updateId: "1001" }),
        }));
      } else {
        expect(from).not.toHaveBeenCalled();
        expect(repository.session.prepareTurn).not.toHaveBeenCalled();
      }
      if (actor !== "human" || !addressed) {
        expect(repository.hitl.authorizeReply).not.toHaveBeenCalled();
      } else {
        expect(repository.hitl.authorizeReply).toHaveBeenCalledWith(expect.objectContaining({
          telegramChatId: "-100",
          telegramMessageId: "3493",
          telegramUserId: "101",
        }));
      }
    },
  );
});
