/**
 * Silent Telegram turn observability tests.
 *
 * Constructs covered:
 * - `telegramSilentTurnLogRecord`: attributes a deliberately undelivered answer to its chat and trigger.
 * - Only verified auth attributes reach the record; participant text and identifiers never do.
 */
import { describe, expect, it } from "vitest";

import { telegramSilentTurnLogRecord } from "./telegram-silent-turn.js";

function auth(attributes: Record<string, unknown>) {
  return {
    attributes,
    authenticator: "telegram",
    principalId: "user-1",
    principalType: "user" as const,
  };
}

describe("telegramSilentTurnLogRecord", () => {
  it("names the chat type, group type and trigger of a silent group turn", () => {
    expect(telegramSilentTurnLogRecord({
      auth: auth({
        groupType: "external",
        telegramChatType: "supergroup",
        telegramGroupTurnTrigger: "name_in_text",
        telegramUserId: "42",
      }),
      agentSessionId: "session-1",
      agentTurnId: "turn-1",
    })).toEqual({
      code: "AGENT_TELEGRAM_SILENT_TURN",
      chatType: "supergroup",
      agentSessionId: "session-1",
      agentTurnId: "turn-1",
      groupType: "external",
      triggeredBy: "name_in_text",
    });
  });

  it("omits group fields for a private chat and ignores non-string attributes", () => {
    expect(telegramSilentTurnLogRecord({
      auth: auth({ telegramChatType: "private", telegramGroupTurnTrigger: 7 }),
      agentSessionId: "session-2",
      agentTurnId: "turn-2",
    })).toEqual({
      code: "AGENT_TELEGRAM_SILENT_TURN",
      chatType: "private",
      agentSessionId: "session-2",
      agentTurnId: "turn-2",
    });
  });

  it.each([null, undefined])("records a missing auth context (%s) as unknown chat rather than failing the turn", (auth) => {
    expect(telegramSilentTurnLogRecord({
      auth,
      agentSessionId: "session-3",
      agentTurnId: "turn-3",
    })).toEqual({
      code: "AGENT_TELEGRAM_SILENT_TURN",
      agentSessionId: "session-3",
      agentTurnId: "turn-3",
    });
  });
});
