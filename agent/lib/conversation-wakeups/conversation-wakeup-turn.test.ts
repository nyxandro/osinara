/**
 * Wake-up turn tests.
 *
 * Constructs covered:
 * - The auth mirrors an ordinary turn of the same chat and carries no Telegram message coordinates,
 *   only the dispatch mark and admission deadline an ordinary turn carries too.
 * - A family-group wake-up carries the group's verified skill policy and memory scope.
 * - The canonical route matches the route an ordinary message of that chat follows.
 * - The model-facing message names the run's own coordinates, note, and limit.
 * - The planned-wakeups block marks a wake-up whose conversation changed.
 */
import { describe, expect, it } from "vitest";

import { EVE_EMPTY_DELIVERY_MARKER } from "../eve-empty-delivery.js";
import { groupCanonicalContinuationToken } from "../sessions/group-canonical-token.js";
import { formatPlannedWakeupsContext } from "./conversation-wakeup-context.js";
import type { PreparedConversationWakeup } from "./conversation-wakeup-preparation.js";
import {
  conversationCanonicalRouteToken,
  conversationWakeupAuth,
  conversationWakeupMessage,
  conversationWakeupRunId,
} from "./conversation-wakeup-turn.js";

const NOW = new Date("2026-09-25T10:00:00.000Z");
const DISPATCH = { deadlineAt: "2026-09-25T10:15:00.000Z", id: "00000000-0000-4000-8000-00000000d001" };

const wakeup: PreparedConversationWakeup = {
  applicationConversationId: "00000000-0000-4000-8000-0000000000c1",
  applicationSessionId: "00000000-0000-4000-8000-0000000000a1",
  authorUserId: "00000000-0000-4000-8000-0000000000u1",
  completedRuns: 2,
  eveSessionId: "ses_eve_1",
  familyId: "family-1",
  forumTopicId: null,
  groupId: null,
  maxRuns: 6,
  messageThreadId: null,
  role: "owner",
  runId: "00000000-0000-4000-8000-0000000000r1",
  sandboxSessionId: "00000000-0000-4000-8000-0000000000t1",
  scenarioPrompt: "Проверь статус заказа 6426132",
  scheduledFor: new Date("2026-09-25T09:59:00.000Z"),
  scheduleId: "00000000-0000-4000-8000-0000000000s1",
  scope: "personal",
  skillAllowlist: [],
  telegramChatId: "101",
  telegramChatType: "private",
  telegramUserId: "101",
  timezone: "Europe/Moscow",
  title: "Доставка кофе",
  userRequest: "Скажи, когда привезут кофе",
};

describe("conversationWakeupAuth", () => {
  it("mirrors an ordinary private turn without any message coordinate", () => {
    const auth = conversationWakeupAuth(wakeup, NOW, DISPATCH);

    expect(auth).toMatchObject({
      attributes: {
        applicationSessionId: wakeup.applicationSessionId,
        familyId: "family-1",
        memoryScopes: ["personal", "family"],
        // Marks every event of the turn and bounds its admission, exactly as for a message.
        osinaraTelegramDeadlineAt: DISPATCH.deadlineAt,
        osinaraTelegramIngressId: DISPATCH.id,
        role: "owner",
        sandboxSessionId: wakeup.sandboxSessionId,
        telegramActorId: "101",
        telegramActorKind: "telegram_user",
        telegramChatId: "101",
        telegramChatType: "private",
        telegramConversationId: wakeup.applicationConversationId,
        telegramUserId: "101",
      },
      authenticator: "telegram",
      principalId: wakeup.authorUserId,
      principalType: "user",
    });
    for (const coordinate of ["telegramMessageId", "telegramTimelineEntryId", "telegramReplyToMessageId", "osinaraTelegramUpdateId", "scheduledRunId"]) {
      expect(auth.attributes).not.toHaveProperty(coordinate);
    }
    expect(conversationWakeupRunId({ current: auth })).toBe(wakeup.runId);
  });

  it("carries the family group's scope, topic and skill policy", () => {
    const auth = conversationWakeupAuth({
      ...wakeup,
      forumTopicId: "7",
      groupId: "group-1",
      messageThreadId: "7",
      scope: "family",
      skillAllowlist: ["pohuy"],
      telegramChatId: "-2001",
      telegramChatType: "supergroup",
    }, NOW, DISPATCH);

    expect(auth.attributes).toMatchObject({
      groupId: "group-1",
      groupType: "family_private",
      memoryScopes: ["family"],
      skillAllowlist: ["pohuy"],
      telegramForumTopicId: "7",
      telegramMessageThreadId: "7",
    });
  });
});

describe("conversationCanonicalRouteToken", () => {
  it("follows the same route as an ordinary message of that chat", () => {
    expect(conversationCanonicalRouteToken({ groupId: null, messageThreadId: null, telegramChatId: "101", telegramForumTopicId: null }))
      .toBe("101::");
    expect(conversationCanonicalRouteToken({ groupId: "group-1", messageThreadId: "7", telegramChatId: "-2001", telegramForumTopicId: "7" }))
      .toBe(groupCanonicalContinuationToken("group-1", 7));
    expect(conversationCanonicalRouteToken({ groupId: "group-1", messageThreadId: null, telegramChatId: "-2001", telegramForumTopicId: null }))
      .toBe(groupCanonicalContinuationToken("group-1", null));
  });
});

describe("conversationWakeupMessage", () => {
  it("names the run, its note and its limit, with the current time as context", () => {
    const { context, message } = conversationWakeupMessage(wakeup, NOW);

    expect(message).toContain("<conversation_wakeup>");
    expect(message).toContain(`schedule_id: ${wakeup.scheduleId}`);
    expect(message).toContain("execution_number: 3");
    expect(message).toContain("max_runs: 6");
    expect(message).toContain("Проверь статус заказа 6426132");
    expect(message).toContain("scheduled_for_local: 2026-09-25 12:59:00 Europe/Moscow");
    expect(context.join("\n")).toContain("captured_at_utc: 2026-09-25T10:00:00.000Z");
    // Silence is offered in the wake-up itself, never in the rules every mode reads.
    expect(message).toContain(EVE_EMPTY_DELIVERY_MARKER);
    expect(message).toContain("pause");
  });
});

describe("formatPlannedWakeupsContext", () => {
  it("lists open wake-ups and marks one left from an earlier conversation", () => {
    const block = formatPlannedWakeupsContext([
      {
        completedRuns: 1, lastErrorCode: null, maxRuns: 6, nextRunAt: new Date("2026-09-25T10:10:00Z"),
        pauseRequested: false, scheduleId: "s1", status: "active", timezone: "Europe/Moscow", title: "Доставка",
      },
      {
        completedRuns: 0, lastErrorCode: "AGENT_SCHEDULE_CONVERSATION_CHANGED", maxRuns: 3,
        nextRunAt: new Date("2026-09-25T11:00:00Z"), pauseRequested: false, scheduleId: "s2", status: "paused",
        timezone: "Europe/Moscow", title: "Сборка",
      },
    ]);

    const payload = JSON.parse(block!.split("\n").at(-2)!);
    expect(payload.wakeups).toEqual([
      expect.objectContaining({ executionsDone: 1, nextRunLocal: "2026-09-25 13:10:00 Europe/Moscow", state: "scheduled", title: "Доставка" }),
      expect.objectContaining({ state: "paused_conversation_changed", title: "Сборка" }),
    ]);
    expect(formatPlannedWakeupsContext([])).toBeNull();
  });
});
