/**
 * The application's reply-authorization boundary: a reply to a bot is an ordinary message turn,
 * unless it targets a conversation whose approval no longer waits.
 */
import { describe, expect, it } from "vitest";

import { parseTelegramUpdate } from "../runtime/telegram/inbound.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";
import { BOT_USERNAME, repositories, telegramContext } from "./telegram-on-message.test-fixtures.js";

describe("Telegram reply dispatch", () => {
  it.each([
    { actor: "human", addressed: true, target: "other", authorization: "not_applicable", dispatch: "send" },
    { actor: "bot", addressed: true, target: "other", authorization: "not_applicable", dispatch: "send" },
    { actor: "channel", addressed: true, target: "other", authorization: "not_applicable", dispatch: "send" },
    { actor: "human", addressed: false, target: "other", authorization: "not_applicable", dispatch: "none" },
    { actor: "human", addressed: true, target: "osinara", authorization: "not_applicable", dispatch: "send" },
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
      const update = parseTelegramUpdate({
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
      });
      if (update?.kind !== "message") throw new Error("TEST_MESSAGE_INVALID");

      const result = await createTelegramMessageHandler(repository)({ ...telegramContext().context,
        ingressRecovery: { updateId: "1001", dispatchId: "123e4567-e89b-42d3-a456-426614174000" } }, update.message);

      expect(result === null ? "none" : "send").toBe(dispatch);
      if (dispatch === "send") {
        expect(result?.message).toBe(durableMessage);
        expect(result?.auth?.attributes).toMatchObject({ memoryScopes: ["group"] });
        expect(repository.session.prepareTurn).toHaveBeenCalledWith(expect.objectContaining({
          baseContinuationToken: "osinara:group:group-1:main",
          kind: "canonical",
        }));
      } else {
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
