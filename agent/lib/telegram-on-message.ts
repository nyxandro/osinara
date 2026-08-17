/**
 * Telegram inbound authorization boundary.
 *
 * Exports:
 * - `createTelegramMessageHandler`: builds an independently testable authorization handler.
 * - `handleTelegramMessage`: production handler using PostgreSQL repositories.
 *
 * Key constructs:
 * - Group reply routing accepts bot or sender-less references only for exact known routes.
 * - Timeline-proven agent replies can start a fresh message turn after application session rotation.
 * - One server-clock snapshot anchors all time-sensitive work and model context in an accepted turn.
 * - Registered groups project the verified dynamic skill policy into turn auth.
 * - Production side-effect adapters are assembled in `telegram-on-message-repositories.ts`.
 */
import type {
  TelegramContext,
  TelegramInboundResult,
  TelegramMessage,
} from "eve/channels/telegram";

import type { StoredTelegramAttachment } from "./attachments/telegram-workspace-attachments.js";
import { isAppError } from "./app-error.js";
import { bindTelegramConversationTimeline } from "./telegram-conversation-timeline.js";
import { evaluateConversationAccess } from "./family-access.js";
import { parseInvitationStartCommand } from "./invitation-code.js";
import { handleTelegramEnrollmentBoundary } from "./telegram-enrollment-boundary.js";
import { groupCanonicalContinuationToken } from "./sessions/group-canonical-token.js";
import {
  classifyTelegramInboundMedia,
  isMessageAddressedToBot,
  isReplyToBot,
} from "./telegram-message-policy.js";
import { parseExternalGroupToolAllowlist } from "./tool-policy/group-tool-catalog.js";
import { telegramForumTopicId } from "./telegram-group-message-storage.js";
import { deliverPendingMemoryThreadNotice } from "./telegram-memory-thread-notice.js";
import { verifiedTelegramProfileSignals } from "./telegram-profile-subjects.js";
import { sameTelegramGroupPolicy } from "./telegram-group-policy-snapshot.js";
import {
  telegramAttachmentScope,
  telegramProactiveDeliveryAuthorization,
  telegramProfileName,
  telegramSessionScope,
  telegramWorkspaceAuthorization,
} from "./telegram-on-message-context.js";
import { buildTelegramTurnResult } from "./telegram-turn-result.js";
import {
  telegramBaseContinuationToken,
  telegramReplyContinuationTokens,
} from "./telegram-reply-routing.js";
import { telegramReplyAttachmentTarget } from "./telegram-reply-attachment.js";
import { telegramReplyTargetSnapshot } from "./telegram-reply-target-snapshot.js";
import {
  productionTelegramMessageRepositories,
  type TelegramMessageRepositories,
} from "./telegram-on-message-repositories.js";
import { prepareTelegramMemoryReviewTurn } from "./memory-review/telegram-memory-review-turn.js";

export function createTelegramMessageHandler(repositories: TelegramMessageRepositories) {
  return async function handleMessage(
    ctx: TelegramContext,
    message: TelegramMessage,
  ): Promise<TelegramInboundResult> {
    const sender = message.from;
    if (!sender || sender.isBot || message.chat.type === "channel") return null;

    // Resolve invocation from verified channel data before any identity or model work.
    const botUsername = ctx.telegram.botUsername;
    if (!botUsername) {
      throw new Error("AGENT_TELEGRAM_CONFIG_MISSING: Не задано имя Telegram-бота");
    }
    const dispatchText = [message.text, message.caption].filter(Boolean).join("\n");
    let addressed = isMessageAddressedToBot({ ...message, text: dispatchText }, botUsername);
    let verifiedReplyRoute: string | undefined;
    let exactReplyRoute: string | undefined;
    let hasResumableReplyRoute = false;
    let resumesPendingTask = false;

    const invitationCode = parseInvitationStartCommand(message.text);
    if (invitationCode && message.chat.type !== "private") {
      // Leaked deep links in any group are dropped silently before identity or session work.
      return null;
    }

    // Registered group policy is required before passive messages may be persisted.
    const groupChatType = message.chat.type === "group" || message.chat.type === "supergroup"
      ? message.chat.type
      : null;
    const group = groupChatType === null
      ? null
      : await repositories.telegram.findGroup(message.chat.id, groupChatType);
    const forumTopicId = group ? telegramForumTopicId(message) : null;
    const mediaKind = classifyTelegramInboundMedia(message);
    const externalAllowlist = group?.type !== "family_private"
      ? parseExternalGroupToolAllowlist(group?.toolAllowlist)
      : null;
    const externalImageAllowed = (mediaKind === "native_photo" ||
      mediaKind === "image_document_candidate") &&
      externalAllowlist?.has("inspect_workspace_image") === true;
    const externalTextAttachmentAllowed = mediaKind === "text_document_candidate" &&
      externalAllowlist?.has("import_telegram_attachment") === true;
    let journalDuplicate = false;
    let inboundTimeline: Awaited<
      ReturnType<TelegramMessageRepositories["journal"]["record"]>
    > | null = null;
    const hasLazyGroupAttachment = group !== null && message.attachments.length > 0 &&
      (group.type === "family_private" || externalImageAllowed || externalTextAttachmentAllowed);
    if (message.chat.type !== "private") {
      if (!group) return null;
      // External media is fail-closed except for the exact capability admitted by its classifier.
      if (group.type !== "family_private" && mediaKind !== "none" &&
        !externalImageAllowed && !externalTextAttachmentAllowed) {
        return null;
      }
      // Every registered group shares one timeline independently of whether this message starts a turn.
      inboundTimeline = await repositories.journal.record(group.groupId, message);
      if (inboundTimeline.status === "duplicate") {
        journalDuplicate = true;
        if (!hasLazyGroupAttachment) return null;
      }
      if (inboundTimeline.replyToAgent) addressed = true;
      const routeEligibleReply = message.replyToMessage &&
        (inboundTimeline.replyToAgent || message.replyToMessage.from?.isBot !== false);
      if (routeEligibleReply) {
        // Telegram may omit the sender entirely from a compact Rich Message reply reference.
        // A route proves a bot/sender-less anchor, but never overrides an explicit user sender.
        const candidateRoutes = telegramReplyContinuationTokens(message);
        exactReplyRoute = candidateRoutes[0];
        for (const candidateRoute of candidateRoutes) {
          if (await repositories.session.hasRoute(candidateRoute)) {
            addressed = true;
            verifiedReplyRoute = candidateRoute;
            hasResumableReplyRoute = true;
            break;
          }
        }
      }
      if (inboundTimeline.replyToAgent && exactReplyRoute === undefined) {
        throw new Error(
          "AGENT_TELEGRAM_TIMELINE_REPLY_ROUTE_MISSING: Для подтверждённого ответа в истории отсутствует Telegram-маршрут",
        );
      }
      // Authorized family attachment references are retained without waking the model.
      if (!addressed && !hasLazyGroupAttachment) {
        if (inboundTimeline.status === "inserted") {
          await repositories.memoryReview.observePassiveMessage({
            groupId: group.groupId,
            timelineEntryId: inboundTimeline.entryId,
          });
        }
        return null;
      }
    } else if (!addressed) {
      return null;
    }

    const identity = await repositories.telegram.findIdentity(sender.id);

    // Group policy and identity are separate DB records. Re-reading the group establishes a
    // fail-closed authorization boundary if owner-only mode, type, or capabilities changed while
    // the incoming message was journaled and participant identity was resolved.
    if (group && groupChatType !== null && !sameTelegramGroupPolicy(
      group,
      await repositories.telegram.findGroup(message.chat.id, groupChatType),
    )) {
      return null;
    }

    // Owner-only external groups retain everyone's timeline but dispatch solely for the current
    // persisted Osinara owner; Telegram administrator status never grants application authority.
    if (
      group?.messageMode === "owner_only" &&
      (
        identity?.familyId !== group.familyId ||
        identity.role !== "owner"
      )
    ) return null;

    if (await handleTelegramEnrollmentBoundary({
      ctx,
      identity,
      invitationCode,
      message,
      repositories,
    })) return null;

    // Auth attributes carry only values derived from the verified webhook and persisted policy.
    const decision = evaluateConversationAccess({
      chat: { id: message.chat.id, type: message.chat.type },
      identity,
      registeredGroup: group,
    });
    if (!decision.allowed) {
      // Group denials remain silent; private users receive a safe enrollment hint.
      if (message.chat.type === "private") await ctx.telegram.sendMessage(decision.error.message);
      return null;
    }

    const access = decision.access;
    const turnStartedAt = new Date();

    // Authorization precedes private persistence. Group persistence already occurred before trigger
    // evaluation so passive registered-group messages remain complete.
    const timelineBinding = await bindTelegramConversationTimeline({
      conversations: repositories.conversations,
      existingGroupTimeline: inboundTimeline,
      familyId: access.familyId,
      groupId: group?.groupId ?? null,
      message,
      timeline: repositories.timeline,
    });
    const conversation = timelineBinding.conversation;
    inboundTimeline = timelineBinding.inboundTimeline;
    if (message.chat.type === "private" && inboundTimeline.status === "duplicate") return null;
    // Group media stays remote until a mode-authorized tool consumes this safe opaque reference.
    const currentAttachment = hasLazyGroupAttachment && group
      ? await repositories.attachmentReferences.record(group.groupId, message)
      : null;
    const replyAttachmentTarget = group && inboundTimeline
      ? telegramReplyAttachmentTarget(message, group)
      : null;
    const replyMediaKind = replyAttachmentTarget
      ? classifyTelegramInboundMedia(replyAttachmentTarget)
      : "none";
    const externalReplyAllowed = (
      (replyMediaKind === "native_photo" || replyMediaKind === "image_document_candidate") &&
      externalAllowlist?.has("inspect_workspace_image") === true
    ) || (
      replyMediaKind === "text_document_candidate" &&
      externalAllowlist?.has("import_telegram_attachment") === true
    );
    const replyAttachment = replyAttachmentTarget && group && inboundTimeline &&
      (group.type === "family_private" || externalReplyAllowed)
      ? await repositories.attachmentReferences.captureReplyTarget(
        group.groupId,
        inboundTimeline.entryId,
        replyAttachmentTarget,
      )
      : null;
    const lazyAttachment = currentAttachment ?? replyAttachment;
    if (!addressed || journalDuplicate) {
      if (!addressed && !journalDuplicate && group && inboundTimeline) {
        await repositories.memoryReview.observePassiveMessage({
          groupId: group.groupId,
          timelineEntryId: inboundTimeline.entryId,
        });
      }
      return null;
    }

    // The accepted verified message reactivates exactly its participant identity before profile
    // selection. This does not enumerate or inject every participant in the conversation.
    await repositories.conversations.syncTimelineParticipants(conversation.id, [inboundTimeline.entryId]);
    const memoryAuthorization = {
      familyId: access.familyId,
      groupId: access.groupId,
      role: access.role,
      scopes: access.memoryScopes,
      telegramUserId: sender.id,
      userId: access.userId,
    };
    let replyHandling: "message" | undefined;
    // A persisted agent timeline anchor is trusted even when Telegram omits compact sender metadata.
    const trustedAgentReply = inboundTimeline?.replyToAgent === true;
    const replyTarget = message.replyToMessage;
    if (replyTarget?.from?.isBot === true || trustedAgentReply) {
      if (!replyTarget) {
        throw new Error(
          "AGENT_TELEGRAM_REPLY_TARGET_MISSING: Для проверки ответа отсутствует Telegram-сообщение назначения",
        );
      }
      const replyAuthorization = await repositories.hitl.authorizeReply({
        baseContinuationToken: telegramBaseContinuationToken(
          message,
          verifiedReplyRoute ?? (trustedAgentReply ? exactReplyRoute : undefined),
        ),
        telegramChatId: message.chat.id,
        telegramMessageId: replyTarget.messageId,
        telegramUserId: sender.id,
      });
      if (replyAuthorization === "forbidden" || replyAuthorization === "expired") {
        const error = replyAuthorization === "forbidden"
          ? "AGENT_APPROVAL_FORBIDDEN: Подтвердить действие может только пользователь, который его запросил."
          : "AGENT_APPROVAL_EXPIRED: Это подтверждение уже использовано или больше не действует.";
        if (message.chat.type === "private") await ctx.telegram.sendMessage(error);
        return null;
      }
      // DB authorization, not a pre-rotation route snapshot, decides whether this is synthetic HITL.
      // Tool-delivered photos/documents are not projected by the final text-delivery event. The
      // verified Telegram sender still proves that this is an ordinary reply to Osinara, not HITL.
      const ordinaryAgentReply = trustedAgentReply ||
        message.chat.type === "private" ||
        isReplyToBot(message, botUsername);
      if (replyAuthorization === "not_applicable" && ordinaryAgentReply) {
        if (!hasResumableReplyRoute) verifiedReplyRoute = exactReplyRoute;
        replyHandling = "message";
      }
      if (replyAuthorization === "authorized") resumesPendingTask = true;
    }

    // Context snapshots and one-time notices are consumed only after reply/HITL authorization has
    // proved that this accepted message will continue into an agent turn.
    const profileSignals = verifiedTelegramProfileSignals(message);
    // Thread lifecycle is silent in shared chats; only a verified private turn may consume notices.
    if (message.chat.type === "private") {
      await deliverPendingMemoryThreadNotice(memoryAuthorization, conversation.id,
        repositories.threadNotices, (text) => ctx.telegram.sendMessage(text));
    }
    if (group) {
      const policyNotice = await repositories.profilePolicies.claimPendingGroupNotice(group.groupId);
      if (policyNotice) {
        await ctx.telegram.sendMessage(`AGENT_PROFILE_PROJECTION_POLICY_NOTICE: ${policyNotice.text}`);
        await repositories.profilePolicies.markGroupNoticePresented({
          deliveryToken: policyNotice.deliveryToken,
          noticeRef: policyNotice.noticeRef,
        });
      }
    }

    let storedAttachments: StoredTelegramAttachment[] = [];
    if (
      message.attachments.length > 0 &&
      message.chat.type === "private"
    ) {
      try {
        storedAttachments = await repositories.attachments.persist({
          attachments: message.attachments,
          auth: telegramWorkspaceAuthorization(decision, group, message),
          chatId: message.chat.id,
          messageId: message.messageId,
          scope: telegramAttachmentScope(decision),
        });
      } catch (error) {
        // The channel boundary informs the user, while rethrowing preserves terminal ingress failure.
        if (isAppError(error)) await ctx.telegram.sendMessage(error.message);
        throw error;
      }
    }
    // One instant anchors session rotation, pending-delivery visibility, and model-visible time.
    const resolvedSessionScope = telegramSessionScope(decision);
    const verifiedForumTopicId = forumTopicId === null ? null : Number(forumTopicId);
    const baseContinuationToken = group
      ? resumesPendingTask
        ? telegramBaseContinuationToken(message, verifiedReplyRoute ?? exactReplyRoute)
        : groupCanonicalContinuationToken(group.groupId, verifiedForumTopicId)
      : telegramBaseContinuationToken(message, verifiedReplyRoute);
    const appSession = await repositories.session.prepareTurn({
      baseContinuationToken,
      familyId: access.familyId,
      kind: resumesPendingTask ? "task" : "canonical",
      now: turnStartedAt,
      telegramForumTopicId: verifiedForumTopicId,
      ...resolvedSessionScope,
    });
    const deliveryAuthorization = telegramProactiveDeliveryAuthorization(decision, message);
    const pendingDeliveries = deliveryAuthorization
      ? await repositories.proactiveDeliveries.listPendingContext({
        ...deliveryAuthorization,
        applicationSessionId: appSession.id,
        now: turnStartedAt,
      })
      : null;
    const replyTargetSnapshot = inboundTimeline?.replyTargetUnavailable
      ? telegramReplyTargetSnapshot(message)
      : null;
    const preparedGroupTurnContext = inboundTimeline
      ? await repositories.groupContext.prepare({
          applicationSessionId: appSession.id,
          attachmentReferenceAccess: group?.type === "family_private"
            ? "all"
            : group?.type === "external"
              ? {
                  images: externalAllowlist?.has("inspect_workspace_image") === true,
                  readableText: externalAllowlist?.has("import_telegram_attachment") === true,
                }
              : "none",
          currentEntryId: inboundTimeline.entryId,
          currentSenderDisplayName: telegramProfileName(message),
          currentSenderUsername: sender.username ?? null,
          currentSequence: inboundTimeline.sequenceId,
          ...(group ? {} : { conversationId: conversation.id }),
          groupId: group?.groupId ?? null,
          messageText: dispatchText,
          messageThreadId: forumTopicId,
          ...(replyTargetSnapshot === null ? {} : { replyTargetSnapshot }),
          replyTargetUnavailable: inboundTimeline.replyTargetUnavailable,
          replyToSequenceId: inboundTimeline.replyToSequenceId,
        })
      : null;
    if (!preparedGroupTurnContext) {
      throw new Error(
        "AGENT_CONVERSATION_TURN_CONTEXT_MISSING: Не удалось подготовить историю разговора",
      );
    }
    const groupTurnContext = group
      ? await prepareTelegramMemoryReviewTurn({
          applicationSessionId: appSession.id,
          conversationId: conversation.id,
          currentEntryId: inboundTimeline.entryId,
          groupId: group.groupId,
          preparedContext: preparedGroupTurnContext,
          repositories: {
            memoryReview: repositories.memoryReview,
            syncParticipants: (conversationId, entryIds) =>
              repositories.conversations.syncTimelineParticipants(conversationId, entryIds),
          },
        })
      : preparedGroupTurnContext;
    if (!group) {
      await repositories.conversations.syncTimelineParticipants(
        conversation.id,
        groupTurnContext.visibleEntryIds,
      );
    }
    const turnResult = buildTelegramTurnResult({
      access,
      appSession,
      conversation,
      forumTopicId,
      group,
      lazyAttachment,
      message,
      pendingDelivery: pendingDeliveries,
      profileSignals,
      profileReplyTimelineSequence: inboundTimeline.replyToSequenceId,
      replyHandling,
      storedAttachments,
      timelineEntryId: inboundTimeline.entryId,
      turnContext: groupTurnContext,
      turnStartedAt,
    });
    if (!group) return turnResult;
    if (!turnResult?.auth) {
      throw new Error(
        "AGENT_TELEGRAM_TURN_AUTH_MISSING: Не удалось подготовить авторизацию Telegram-turn",
      );
    }

    // Dynamic tools and skills consume the same verified registration snapshot as this turn.
    return {
      ...turnResult,
      auth: {
        ...turnResult.auth,
        attributes: {
          ...turnResult.auth.attributes,
          skillAllowlist: group.skillAllowlist,
        },
      },
    };
  };
}

export const handleTelegramMessage = createTelegramMessageHandler(
  productionTelegramMessageRepositories,
);
