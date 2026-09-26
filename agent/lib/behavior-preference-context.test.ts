/**
 * Verified chat communication preference authorization tests.
 *
 * Constructs covered:
 * - Exact conversation, timeline source, actor, and sequence extraction.
 * - Rejection of incomplete or non-Telegram runtime identity.
 */
import type { ToolContext } from "eve/tools";
import { describe, expect, it } from "vitest";

import { requireBehaviorPreferenceAuthorization } from "./behavior-preference-context.js";
import { requireBehaviorPreferenceReadAuthorization } from "./behavior-preference-context.js";

function context(
  attributes: Record<string, unknown>,
  authenticator = "telegram",
  initiatorAttributes?: Record<string, unknown>,
): ToolContext {
  return {
    session: {
      auth: {
        current: {
          attributes,
          authenticator,
          principalId: "user-1",
          principalType: "user",
        },
        initiator: initiatorAttributes
          ? {
              attributes: initiatorAttributes,
              authenticator: "telegram",
              principalId: "user-1",
              principalType: "user",
            }
          : undefined,
      },
      id: "session-1",
      turn: { id: "turn-1" },
    },
  } as unknown as ToolContext;
}

const validAttributes = {
  telegramConversationId: "conversation-1",
  telegramTimelineEntryId: "entry-1",
  telegramTimelineSequence: "42",
  telegramUserId: "telegram-user-1",
};

describe("requireBehaviorPreferenceAuthorization", () => {
  it("reads chat preferences on a verified approval continuation without inventing a mutation source", () => {
    const resumed = context({ telegramApprovalContinuation: "true", telegramApprovalScope: "personal",
      familyId: "family-1", telegramChatType: "private", telegramChatId: "101" });
    expect(requireBehaviorPreferenceReadAuthorization(resumed)).toEqual({
      kind: "approval", actorUserId: "user-1", familyId: "family-1", groupId: null, scope: "personal", telegramChatId: "101",
    });
    expect(() => requireBehaviorPreferenceAuthorization(resumed)).toThrow("AGENT_BEHAVIOR_PREFERENCE_CONTEXT_INVALID");
    expect(() => requireBehaviorPreferenceReadAuthorization(context({ telegramApprovalContinuation: "true" })))
      .toThrow("AGENT_BEHAVIOR_PREFERENCE_CONTEXT_INVALID");
  });
  it("projects exact verified current-turn identity", () => {
    expect(requireBehaviorPreferenceAuthorization(context(validAttributes))).toEqual({
      conversationId: "conversation-1",
      sourceSequence: "42",
      telegramUserId: "telegram-user-1",
      timelineEntryId: "entry-1",
    });
  });

  it("rejects missing identity, invalid sequence, and non-Telegram auth", () => {
    for (const candidate of [
      context({ ...validAttributes, telegramConversationId: undefined }),
      context({ ...validAttributes, telegramTimelineSequence: "-1" }),
      context(validAttributes, "memory-review"),
    ]) {
      expect(() => requireBehaviorPreferenceAuthorization(candidate)).toThrowError(
        /AGENT_BEHAVIOR_PREFERENCE_CONTEXT_INVALID/u,
      );
    }
  });

  it("reads the chat's prompt for a wake-up turn that answers no message", () => {
    const wakeup = (attributes: Record<string, unknown>) => context({
      applicationSessionId: "application-session-1",
      conversationScheduleRunId: "run-1",
      familyId: "family-1",
      telegramChatId: "101",
      telegramChatType: "private",
      telegramConversationId: "conversation-1",
      telegramUserId: "101",
      ...attributes,
    });

    expect(requireBehaviorPreferenceReadAuthorization(wakeup({}))).toEqual({
      actorUserId: "user-1", familyId: "family-1", groupId: null, kind: "wakeup", scope: "personal", telegramChatId: "101",
    });
    expect(requireBehaviorPreferenceReadAuthorization(wakeup({
      groupId: "group-1", groupType: "family_private", telegramChatId: "-2001", telegramChatType: "supergroup",
    }))).toMatchObject({ groupId: "group-1", kind: "wakeup", scope: "family" });
    // No mutation source exists in a wake-up, so style changes stay refused.
    expect(() => requireBehaviorPreferenceAuthorization(wakeup({}))).toThrow("AGENT_BEHAVIOR_PREFERENCE_CONTEXT_INVALID");
  });

  it("projects a scheduled chat as read-only authorization without a timeline source", () => {
    const scheduledAttributes = {
      applicationSessionId: "application-session-1",
      familyId: "family-1",
      memoryScopes: ["family"],
      groupId: "group-1",
      groupType: "family_private",
      scheduleScheduledFor: "2026-08-16T10:00:00.000Z",
      scheduleTitle: "Сводка",
      scheduledRunId: "run-1",
      telegramChatId: "-1001",
    };
    const scheduled = context(scheduledAttributes);

    expect(requireBehaviorPreferenceReadAuthorization(scheduled)).toEqual({
      actorUserId: "user-1",
      familyId: "family-1",
      groupId: "group-1",
      kind: "scheduled",
      scope: "family",
      telegramChatId: "-1001",
    });
    expect(() => requireBehaviorPreferenceAuthorization(scheduled)).toThrowError(
      /AGENT_BEHAVIOR_PREFERENCE_CONTEXT_INVALID/u,
    );

    // Metadata from a scheduled initiator cannot be combined with an ordinary current caller.
    expect(() => requireBehaviorPreferenceReadAuthorization(
      context(validAttributes, "telegram", scheduledAttributes),
    )).toThrowError(/AGENT_BEHAVIOR_PREFERENCE_CONTEXT_INVALID/u);
  });
});
