/**
 * Shared Telegram authorization-boundary test fixtures.
 *
 * Exports:
 * - `BOT_USERNAME`: stable bot identity used by dispatch tests.
 * - `privateMessage`, `groupMessage`, and `botGroupMessage`: minimal parsed Eve Telegram messages.
 * - `telegramContext`: Telegram channel context with an observable sender.
 * - `repositories`: isolated application repository doubles for message-handler tests.
 */
import type { TelegramContext, TelegramMessage } from "eve/channels/telegram";
import { vi } from "vitest";

export const BOT_USERNAME = "osinara_bot";

export function privateMessage(text: string): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: "telegram-101", type: "private" },
    from: { firstName: "Анна", id: "telegram-101", isBot: false, username: "anna" },
    messageId: "1",
    raw: { date: 1_700_000_000 },
    text,
  };
}

export function groupMessage(text: string): TelegramMessage {
  return {
    ...privateMessage(text),
    chat: { id: "group-101", title: "Группа", type: "group" },
  };
}

/** Another bot in the same group, as Telegram delivers it under Bot-to-Bot Communication Mode. */
export function botGroupMessage(text: string): TelegramMessage {
  return {
    ...groupMessage(text),
    from: { firstName: "Мия", id: "8123456789", isBot: true, username: "mimimia_ai_bot" },
    raw: {
      date: 1_700_000_000,
      from: { first_name: "Мия", id: 8_123_456_789, is_bot: true, username: "mimimia_ai_bot" },
    },
  };
}

export function telegramContext() {
  const sendMessage = vi.fn().mockResolvedValue({});
  return {
    context: {
      telegram: {
        botUsername: BOT_USERNAME,
        sendMessage,
      },
    } as unknown as TelegramContext,
    sendMessage,
  };
}

export function repositories() {
  return {
    attachmentReferences: {
      captureReplyTarget: vi.fn().mockResolvedValue(null),
      record: vi.fn().mockResolvedValue({
        attachmentId: "00000000-0000-4000-8000-000000000099",
        fileName: "семейный файл.pdf",
        kind: "document",
        mediaType: "application/pdf",
        size: 1_024,
        telegramMessageId: "1",
      }),
    },
    attachments: {
      persist: vi.fn().mockResolvedValue([]),
    },
    conversations: {
      getByChatId: vi.fn().mockResolvedValue({
        familyId: "family-1",
        id: "conversation-private-1",
        label: "Анна",
        ownerUserId: "user-1",
        scope: "personal",
        scopePartitionKey: "user-1",
        telegramChatId: "telegram-101",
        telegramGroupId: null,
      }),
      getByGroupId: vi.fn().mockResolvedValue({
        familyId: "family-1",
        id: "conversation-group-1",
        label: "Группа",
        ownerUserId: null,
        scope: "family",
        scopePartitionKey: "family-1",
        telegramChatId: "group-101",
        telegramGroupId: "group-1",
      }),
      syncTimelineParticipants: vi.fn().mockResolvedValue([]),
    },
    family: {
      claimInvitation: vi.fn(),
    },
    groupContext: {
      prepare: vi.fn().mockResolvedValue({
        cursorSequence: "1",
        durableMessage: "<current_telegram_message>test</current_telegram_message>",
        currentMessageEnvelope: "<current_telegram_message>test</current_telegram_message>",
        omittedBeforeSequence: null,
        timelineOmission: null,
        visibleEntryIds: ["00000000-0000-4000-8000-000000000010"],
        visibleTimelineEntries: [],
      }),
    },
    hitl: {
      authorizeReply: vi.fn().mockResolvedValue("not_applicable"),
    },
    profilePolicies: {
      claimPendingGroupNotice: vi.fn().mockResolvedValue(null),
      markGroupNoticePresented: vi.fn().mockResolvedValue(undefined),
    },
    profiles: {
      create: vi.fn().mockResolvedValue({
        generatedAt: "2026-08-08T00:00:00.000Z",
        profileViewRef: "view_00000000000000000000000000000001",
        subjects: [],
        totalCharacters: 0,
      }),
    },
    journal: {
      listBefore: vi.fn().mockResolvedValue([]),
      listRecent: vi.fn().mockResolvedValue([]),
      record: vi.fn().mockResolvedValue({
        entryId: "00000000-0000-4000-8000-000000000010",
        replyToAgent: false,
        replyTargetUnavailable: false,
        replyToSequenceId: null,
        sequenceId: "1",
        status: "inserted",
      }),
    },
    memoryReview: {
      failInteractivePreparation: vi.fn().mockResolvedValue(undefined),
      observePassiveMessage: vi.fn().mockResolvedValue(null),
      prepareInteractiveTurn: vi.fn().mockResolvedValue(null),
    },
    proactiveDeliveries: {
      listPendingContext: vi.fn().mockResolvedValue(null),
    },
    session: {
      prepareAuthorizedResponse: vi.fn().mockResolvedValue({ continuationToken: "telegram-101::",generation: 0,id: "session-1",
        rotated: false,sandboxSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",nativeSessionId: "eve-response-session" }),
      hasRoute: vi.fn().mockResolvedValue(false),
      prepareTurn: vi.fn().mockResolvedValue({
        continuationToken: "telegram-101::",
        generation: 0,
        id: "session-1",
        rotated: false,
        sandboxSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    },
    telegram: {
      claimFirstOwner: vi.fn(),
      findGroup: vi.fn().mockResolvedValue(null),
      findIdentity: vi.fn().mockResolvedValue(null),
      hasOwner: vi.fn(),
    },
    turnInterjections: {
      findDeliveredContentKind: vi.fn().mockResolvedValue(null),
    },
    conversationWakeups: {
      listPlanned: vi.fn().mockResolvedValue([]),
    },
    timeline: {
      recordInbound: vi.fn().mockResolvedValue({
        entryId: "00000000-0000-4000-8000-000000000011",
        replyTargetUnavailable: false,
        replyToSequenceId: null,
        sequenceId: "1",
        status: "inserted",
      }),
    },
    threadNotices: {
      complete: vi.fn(),
      fail: vi.fn(),
      takePending: vi.fn().mockResolvedValue(null),
    },
  };
}
