/**
 * Verified chat communication preference authorization tests.
 *
 * Constructs covered:
 * - Exact conversation, timeline source, actor, and sequence extraction.
 * - Rejection of incomplete or non-Telegram runtime identity.
 * - A post on behalf of a channel in an external group reads its chat's notes and changes nothing.
 * - A background task's own turn reads its chat's notes and changes nothing (#530).
 */
import type { ToolContext } from "../runtime/tool.js";
import { describe, expect, it } from "vitest";

import { requireBehaviorPreferenceAuthorization } from "./behavior-preference-context.js";
import { requireBehaviorPreferenceReadAuthorization } from "./behavior-preference-context.js";
import { backgroundTaskAuth } from "./background-tasks/background-task-access.js";
import type { BackgroundTask } from "./background-tasks/background-task-records.js";

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

  it("reads the chat's prompt for a child of a wake-up or of a background task's report (#519)", () => {
    const base = {
      applicationSessionId: "application-session-1", familyId: "family-1", telegramChatId: "101",
      telegramChatType: "private", telegramConversationId: "conversation-1", telegramUserId: "101",
    };
    // A delegated child inherits its parent's auth and has a parent of its own.
    const child = (attributes: Record<string, unknown>) => {
      const ctx = context({ ...base, ...attributes });
      return { ...ctx, session: { ...ctx.session, parent: { callId: "call-1", sessionId: "session-0", turnId: "turn-0" } } } as unknown as ToolContext;
    };
    for (const marker of [{ conversationScheduleRunId: "run-1" }, { backgroundTaskEventId: "17" }]) {
      expect(requireBehaviorPreferenceReadAuthorization(child(marker))).toMatchObject({ kind: "wakeup", scope: "personal" });
    }
  });

  it("reads its chat's notes in a background task's own turn, and changes nothing (#530)", () => {
    // The task's turn answers no message: its auth is built exactly as production builds it.
    const taskTurn = (task: Partial<BackgroundTask>) => {
      const auth = backgroundTaskAuth({
        access: { applicationConversationId: "conversation-1", role: "owner", skillAllowlist: [], telegramUserId: "101" },
        applicationSessionId: "application-session-1",
        now: new Date("2026-11-18T12:00:00Z"),
        summary: false,
        task: {
          authorUserId: "user-1", familyId: "family-1", forumTopicId: null, groupId: null, id: "task-1",
          messageThreadId: null, sandboxSessionId: "sandbox-1", telegramChatId: "101", telegramChatType: "private",
          ...task,
        } as BackgroundTask,
      });
      return { session: { auth: { current: auth, initiator: auth }, id: "session-1", turn: { id: "turn-1" } } } as unknown as ToolContext;
    };

    expect(requireBehaviorPreferenceReadAuthorization(taskTurn({}))).toEqual({
      actorUserId: "user-1", familyId: "family-1", groupId: null, kind: "background_task", scope: "personal", telegramChatId: "101",
    });
    expect(requireBehaviorPreferenceReadAuthorization(taskTurn({
      groupId: "group-1", telegramChatId: "-2001", telegramChatType: "supergroup",
    }))).toEqual({
      actorUserId: "user-1", familyId: "family-1", groupId: "group-1", kind: "background_task", scope: "family", telegramChatId: "-2001",
    });
    // A task never changes the chat's notes: it has no message of the chat to order a change by.
    expect(() => requireBehaviorPreferenceAuthorization(taskTurn({}))).toThrow("AGENT_BEHAVIOR_PREFERENCE_CONTEXT_INVALID");
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

  it("reads an external group's notes for a post on behalf of a channel, never changing them", () => {
    const channel = (attributes: Record<string, unknown>, principalId = "telegram-channel:-100999") => ({
      session: {
        auth: {
          current: {
            attributes: {
              groupId: "group-1",
              groupType: "external",
              telegramActorId: "-100999",
              telegramActorKind: "telegram_channel",
              telegramConversationId: "conversation-1",
              telegramTimelineEntryId: "entry-1",
              telegramTimelineSequence: "42",
              ...attributes,
            },
            authenticator: "telegram",
            principalId,
            principalType: "service",
          },
        },
        id: "session-1",
        turn: { id: "turn-1" },
      },
    }) as unknown as ToolContext;

    expect(requireBehaviorPreferenceReadAuthorization(channel({}))).toEqual({
      conversationId: "conversation-1",
      kind: "channel",
      sourceSequence: "42",
      telegramSenderChatId: "-100999",
      timelineEntryId: "entry-1",
    });
    expect(() => requireBehaviorPreferenceAuthorization(channel({}))).toThrow("AGENT_BEHAVIOR_PREFERENCE_CHANNEL_FORBIDDEN");
    // Only a verified channel identity in an external group reads this way.
    for (const candidate of [
      channel({}, "telegram-channel:-100111"),
      channel({ groupType: "family_private" }),
      channel({ telegramTimelineSequence: "x" }),
    ]) {
      expect(() => requireBehaviorPreferenceReadAuthorization(candidate)).toThrow("AGENT_BEHAVIOR_PREFERENCE_CONTEXT_INVALID");
    }
  });
});
