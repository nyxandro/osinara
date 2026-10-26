/**
 * Final trusted Telegram inbound result assembly.
 *
 * Exports:
 * - `buildTelegramTurnResult`: composes internal auth attributes and bounded model context.
 */
import type { TelegramInboundResult } from "../runtime/telegram/channel-types.js";
import type { TelegramMessage } from "../runtime/telegram/inbound.js";

import type { StoredTelegramAttachment } from "./attachments/telegram-workspace-attachments.js";
import { formatCurrentTimeContext } from "./current-time.js";
import type { ApplicationConversation } from "./conversation-repository.js";
import type { ConversationAccess, RegisteredGroup } from "./family-access.js";
import type { PreparedTelegramGroupTurnContext } from "./telegram-group-turn-context.js";
import type { TelegramGroupAttachmentSummary } from "./telegram-group-journal-context.js";
import type { PreparedSession } from "./sessions/session-repository.js";
import type { TelegramInboundActor } from "./telegram-inbound-actor.js";
import type { TelegramGroupTurnTrigger } from "./telegram-message-policy.js";
import {
  formatStoredTelegramAttachments,
  formatTelegramAttachmentReferences,
} from "./telegram-on-message-context.js";
import { alreadySeenTurnContext, turnInterjectionMarkerContext } from "./turn-interjection/turn-interjection-block.js";
import { TURN_INTERJECTION_MARKER_ATTRIBUTE } from "./turn-interjection/turn-interjection-scope.js";
import {
  formatPlannedWakeupsContext,
  type PlannedConversationWakeup,
} from "./conversation-wakeups/conversation-wakeup-context.js";
import type { TurnInterjectionContentKind } from "./turn-interjection/turn-interjection-repository.js";

export function buildTelegramTurnResult(input: {
  access: ConversationAccess;
  actor: TelegramInboundActor;
  appSession: PreparedSession;
  conversation: ApplicationConversation;
  forumTopicId: string | null;
  group: RegisteredGroup | null;
  /** Present for every group turn so the channel can attribute a silent turn to its trigger. */
  groupTurnTrigger: TelegramGroupTurnTrigger | null;
  lazyAttachment: (TelegramGroupAttachmentSummary & { telegramMessageId: string }) | null;
  message: TelegramMessage;
  pendingDelivery: { context: string; cursor: string } | null;
  /** Open wake-ups of this chat's conversation, so the message can be related to them. */
  plannedWakeups: readonly PlannedConversationWakeup[];
  profileReplyTimelineSequence: string | null;
  profileSignals: {
    explicitMentionTelegramUserIds: readonly string[];
    replyTelegramUserId: string | null;
  };
  /** What a running turn already saw of this message, when it was shown with a tool result. */
  shownDuringTurn: TurnInterjectionContentKind | null;
  storedAttachments: readonly StoredTelegramAttachment[];
  timelineEntryId: string;
  turnContext: PreparedTelegramGroupTurnContext;
  /** Announced to the model here, so only a block carrying it counts as the author's new message. */
  turnInterjectionMarker: string | null;
  turnStartedAt: Date;
}): TelegramInboundResult {
  const context = [
    // One line per turn: scope and role can differ between authors of a group. Delivery formatting
    // is a constant of the core instructions, not a per-turn fact.
    `Verified turn: scope ${input.access.memoryScopes.join(", ")}; role ${input.access.role}; actor ${input.actor.kind}.`,
    formatCurrentTimeContext(input.turnStartedAt),
  ];
  if (input.storedAttachments.length > 0) {
    context.push(formatStoredTelegramAttachments(input.storedAttachments));
  }
  if (input.lazyAttachment) context.push(formatTelegramAttachmentReferences([input.lazyAttachment]));
  if (input.pendingDelivery) context.push(input.pendingDelivery.context);
  if (input.shownDuringTurn) context.push(alreadySeenTurnContext(input.shownDuringTurn));
  if (input.turnInterjectionMarker) context.push(turnInterjectionMarkerContext(input.turnInterjectionMarker));
  const plannedWakeups = formatPlannedWakeupsContext(input.plannedWakeups);
  if (plannedWakeups) context.push(plannedWakeups);
  return {
    auth: {
      attributes: {
        applicationSessionId: input.appSession.id,
        familyId: input.access.familyId,
        ...(input.access.groupId ? { groupId: input.access.groupId } : {}),
        ...(input.group ? { groupType: input.group.type } : {}),
        ...(input.groupTurnTrigger === null ? {} : { telegramGroupTurnTrigger: input.groupTurnTrigger }),
        memoryScopes: input.access.memoryScopes,
        ...(input.pendingDelivery ? { proactiveDeliveryCursor: input.pendingDelivery.cursor } : {}),
        role: input.access.role,
        sandboxSessionId: input.appSession.sandboxSessionId,
        telegramChatId: input.message.chat.id,
        telegramChatType: input.message.chat.type,
        telegramConversationId: input.conversation.id,
        ...(input.forumTopicId === null ? {} : { telegramForumTopicId: input.forumTopicId }),
        telegramMessageId: input.message.messageId,
        ...(input.profileSignals.explicitMentionTelegramUserIds.length === 0
          ? {}
          : { telegramProfileMentionUserIds: input.profileSignals.explicitMentionTelegramUserIds }),
        ...(input.profileSignals.replyTelegramUserId === null
          ? {}
          : { telegramProfileReplyUserId: input.profileSignals.replyTelegramUserId }),
        ...(input.profileReplyTimelineSequence === null
          ? {}
          : { telegramProfileReplyTimelineSequence: input.profileReplyTimelineSequence }),
        telegramTurnStartedAt: input.turnStartedAt.toISOString(),
        ...(input.turnInterjectionMarker === null
          ? {}
          : { [TURN_INTERJECTION_MARKER_ATTRIBUTE]: input.turnInterjectionMarker }),
        ...(input.message.messageThreadId === undefined
          ? {}
          : { telegramMessageThreadId: String(input.message.messageThreadId) }),
        ...(input.message.chat.type === "private"
          ? {}
          : { telegramReplyToMessageId: input.message.messageId }),
        ...(input.turnContext.omittedBeforeSequence === null
          ? {}
          : { telegramTimelineOmittedBeforeSequence: input.turnContext.omittedBeforeSequence }),
        telegramTimelineEntryId: input.timelineEntryId,
        telegramTimelineSequence: input.turnContext.cursorSequence,
        telegramTimelineVisibleEntryIds: input.turnContext.visibleEntryIds,
        ...(input.turnContext.memoryReviewBatchId === undefined
          ? {}
          : { memoryReviewBatchId: input.turnContext.memoryReviewBatchId }),
        ...(input.turnContext.memoryReviewBatchId === undefined
          ? {}
          : { memoryReviewMode: "interactive" }),
        ...(input.turnContext.memoryReviewSourceEntryIds === undefined
          ? {}
          : { memoryReviewSourceEntryIds: input.turnContext.memoryReviewSourceEntryIds }),
        telegramActorId: input.actor.id,
        telegramActorKind: input.actor.kind,
        // A bot carries a real Telegram user id, so it identifies itself exactly like a person.
        // Only a channel has no user identity at all.
        ...(input.actor.kind === "telegram_channel" ? {} : { telegramUserId: input.actor.id }),
        ...(input.group && input.group.type !== "family_private"
          ? { toolAllowlist: input.group.toolAllowlist }
          : {}),
      },
      authenticator: "telegram",
      principalId: input.access.userId ?? input.actor.actorId,
      principalType: input.actor.kind === "telegram_user" ? "user" : "service",
    },
    context,
    continuationToken: input.appSession.continuationToken,
    message: input.turnContext.durableMessage,
  };
}
