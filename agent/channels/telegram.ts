/**
 * Eve Telegram channel.
 *
 * Constructs:
 * - Verified webhook transport with durable PostgreSQL ingress.
 * - Application-owned family/group authorization in `onMessage`.
 * - Durable identity-bound HITL callbacks and replies.
 * - Validated attachment persistence with model-safe workspace references.
 * - Completed ordinary/Rich Message or silent reaction delivery without speculative chat drafts.
 * - Scheduled final delivery bound to its owner-approved Telegram chat and forum topic.
 * - Verified group replies anchored to the triggering member message.
 * - Successfully delivered final group output persisted as one logical timeline entry.
 */
import { telegramChannel } from "eve/channels/telegram";

import { handleTelegramDurableIngress } from "../lib/telegram-durable-ingress.js";
import { formatTelegramTurnFailure } from "../lib/telegram-interface.js";
import { TELEGRAM_EVE_UPLOAD_POLICY } from "../lib/telegram-message-policy.js";
import { handleTelegramMessage } from "../lib/telegram-on-message.js";
import { completedTelegramOutput } from "../lib/telegram-progress.js";
import { deliverTelegramFinalOutput } from "../lib/telegram-final-delivery.js";
import { telegramFinalDeliveryRepository } from "../lib/telegram-final-delivery-repository.js";
import { postTelegramRichMessageChunk } from "../lib/telegram-rich-messages.js";
import { postTelegramPlainMessageChunk } from "../lib/telegram-plain-messages.js";
import {
  applicationSessionId,
  registerTelegramDeliveredMessageRoutes,
} from "../lib/sessions/session-context.js";
import { sessionRepository } from "../lib/sessions/session-repository.js";
import { groupTimelineCursorRepository } from "../lib/sessions/group-timeline-cursor-repository.js";
import { authorizeTelegramHitlCallback } from "../lib/telegram-hitl/callback-authorization.js";
import { handleTelegramInputRequested } from "../lib/telegram-hitl/input-request.js";
import { telegramHitlApprovalRepository } from "../lib/telegram-hitl/approval-repository.js";
import {
  handleTelegramSessionFailure,
} from "../lib/telegram-session-failure.js";
import { telegramTurnReplyParameters } from "../lib/telegram-reply.js";
import { agentScheduleDispatchRepository } from "../lib/agent-schedules/agent-schedule-dispatch-repository.js";
import {
  isScheduledSession,
  scheduledDeliveryMetadata,
} from "../lib/agent-schedules/scheduled-session.js";
import {
  requireScheduledTelegramTarget,
  SCHEDULED_TELEGRAM_TARGET_MISMATCH_CODE,
  scheduledTelegramTargetMatches,
} from "../lib/agent-schedules/scheduled-telegram-target.js";
import { proactiveDeliveryRepository } from "../lib/proactive-deliveries/proactive-delivery-repository.js";
import { telegramGroupJournalRepository } from "../lib/telegram-group-journal-repository.js";
import { postTelegramMessageWithoutContinuationChange } from "../lib/telegram-stable-delivery.js";
import { shouldNotifyTelegramFailure } from "../lib/telegram-failure-notification.js";
import { AppError } from "../lib/app-error.js";
import { conversationTimelineRepository } from "../lib/conversation-timeline-repository.js";
import { setTelegramMessageReaction } from "../lib/telegram-message-reaction.js";
import {
  bindMemoryTurnSources,
  releaseMemoryTurnSources,
} from "../lib/memory-turn-source.js";
import { memoryReviewBatchId } from "../lib/memory-review/memory-review-session.js";
import { memoryReviewRepository } from "../lib/memory-review/memory-review-repository.js";
import { memoryReviewDispatchRepository } from "../lib/memory-review/memory-review-dispatch-repository.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export default telegramChannel({
  botUsername: process.env.TELEGRAM_BOT_USERNAME as string,
  credentials: {
    webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN as string,
  },
  drainRoute: "/eve/v1/telegram-drain",
  events: {
    "input.requested": handleTelegramInputRequested,
    async "message.completed"(data, channel, ctx) {
      // Model-authored pre-tool text is a user-visible progress update, not technical tool noise.
      if (isScheduledSession(ctx) && data.finishReason !== "stop") return;
      const output = completedTelegramOutput(data);
      if (!output) return;
      const sessionId = applicationSessionId(ctx);
      if (!await sessionRepository.isCurrentEveSession(sessionId, ctx.session.id)) return;
      const currentAttributes = ctx.session.auth.current?.attributes;
      const scheduledDelivery = scheduledDeliveryMetadata(ctx);
      if (output.kind === "reaction") {
        const telegramMessageId = currentAttributes?.telegramMessageId;
        if (isScheduledSession(ctx) || typeof telegramMessageId !== "string") {
          throw new AppError(
            "AGENT_TELEGRAM_REACTION_TARGET_MISSING",
            "Не удалось определить сообщение для реакции. Отправьте обращение ещё раз",
          );
        }
        await setTelegramMessageReaction(channel.telegram, telegramMessageId, output.emoji);
        return;
      }
      const message = output.message;
      if (scheduledDelivery) {
        // Database authorization is meaningful only when it protects the exact active side-effect target.
        requireScheduledTelegramTarget(channel.telegram, scheduledDelivery);
        await agentScheduleDispatchRepository.authorizeDelivery({
          applicationSessionId: sessionId,
          eveSessionId: ctx.session.id,
          familyId: scheduledDelivery.familyId,
          groupId: scheduledDelivery.groupId,
          messageThreadId: scheduledDelivery.messageThreadId,
          ownerUserId: scheduledDelivery.ownerUserId,
          runId: scheduledDelivery.runId,
          scope: scheduledDelivery.scope,
          telegramChatId: scheduledDelivery.telegramChatId,
        });
      }
      const replyParameters = isScheduledSession(ctx)
        ? undefined
        : telegramTurnReplyParameters(channel.state, ctx);
      const sentMessages = await deliverTelegramFinalOutput({
        applicationSessionId: sessionId,
        deliveryIdentity: {
          chatId: channel.telegram.chatId,
          messageThreadId: channel.telegram.messageThreadId ?? null,
          replyParameters: replyParameters ?? null,
        },
        eveSessionId: ctx.session.id,
        eveTurnId: ctx.session.turn.id,
        markdown: message,
        sendChunk: (chunk, ordinal) => chunk.format === "plain"
          ? postTelegramPlainMessageChunk(
              chunk.text,
              channel,
              ordinal === 0 ? replyParameters : undefined,
            )
          : postTelegramRichMessageChunk(
              chunk.text,
              channel.telegram,
              channel.state,
              ordinal === 0 ? replyParameters : undefined,
            ),
      });
      const deliveredAt = new Date();
      const groupId = scheduledDelivery?.groupId ??
        (typeof currentAttributes?.groupId === "string" ? currentAttributes.groupId : null);
      if (scheduledDelivery) {
        const firstMessage = sentMessages[0];
        if (!firstMessage) {
          throw new Error(
            "AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING: Telegram не подтвердил доставку результата расписания",
          );
        }
        await agentScheduleDispatchRepository.completeDeliveredRun({
          applicationSessionId: sessionId,
          content: message,
          deliveredAt,
          eveSessionId: ctx.session.id,
          familyId: scheduledDelivery.familyId,
          groupId: scheduledDelivery.groupId,
          messageThreadId: scheduledDelivery.messageThreadId,
          ownerUserId: scheduledDelivery.ownerUserId,
          runId: scheduledDelivery.runId,
          scheduledFor: new Date(scheduledDelivery.scheduledFor),
          scope: scheduledDelivery.scope,
          telegramChatId: scheduledDelivery.telegramChatId,
          telegramMessageId: firstMessage.messageId,
          title: scheduledDelivery.title,
        });
      }
      const conversationId = typeof currentAttributes?.telegramConversationId === "string"
        ? currentAttributes.telegramConversationId
        : null;
      if ((conversationId || groupId) && data.finishReason === "stop") {
        const replyToEntryId = typeof currentAttributes?.telegramTimelineEntryId === "string"
          ? currentAttributes.telegramTimelineEntryId
          : null;
        const forumTopicId = scheduledDelivery?.forumTopicId ??
          (typeof currentAttributes?.telegramForumTopicId === "string"
            ? currentAttributes.telegramForumTopicId
            : null);
        // The primary delivery receipt is durable before this secondary conversation projection.
        if (groupId) {
          await telegramGroupJournalRepository.recordAgentResponse({
            applicationSessionId: isScheduledSession(ctx) ? null : sessionId,
            contentText: message,
            deliveredAt,
            groupId,
            messageThreadId: forumTopicId,
            replyToEntryId,
            telegramMessageIds: sentMessages.map((sent) => sent.messageId),
          });
        } else if (conversationId) {
          await conversationTimelineRepository.recordAgentResponse({
            applicationSessionId: sessionId,
            contentText: message,
            conversationId,
            deliveredAt,
            messageThreadId: null,
            replyToEntryId,
            telegramMessageIds: sentMessages.map((sent) => sent.messageId),
          });
        }
      }
      if (!isScheduledSession(ctx)) {
        await registerTelegramDeliveredMessageRoutes(
          channel,
          ctx,
          sentMessages.map((sent) => sent.messageId),
        );
      }
    },
    async "session.failed"(data, channel) {
      const failureRepository = {
        async recordSessionFailedByContinuationToken(
          continuationToken: string,
          eveSessionId: string,
        ) {
          return await memoryReviewDispatchRepository.markInteractiveSessionAmbiguous({
            continuationToken,
            diagnosticCode: "AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS",
            eveSessionId,
          }) ?? await sessionRepository.recordSessionFailedByContinuationToken(
            continuationToken,
            eveSessionId,
          );
        },
      };
      await handleTelegramSessionFailure(
        data,
        channel,
        failureRepository,
        agentScheduleDispatchRepository,
      );
    },
    async "turn.failed"(data, channel, ctx) {
      // Terminal failure releases the temporary timeline retention after all tool writes have stopped.
      await releaseMemoryTurnSources(ctx);
      const reviewBatchId = memoryReviewBatchId(ctx);
      let reviewFailureReplayed = false;
      if (reviewBatchId) {
        const terminal = await memoryReviewRepository.failRunning({
          batchId: reviewBatchId,
          diagnosticCode: data.code,
          eveSessionId: ctx.session.id,
        });
        reviewFailureReplayed = terminal === "replayed";
      }
      const sessionId = applicationSessionId(ctx);
      const scheduledDelivery = scheduledDeliveryMetadata(ctx);
      // The durable terminal replay still performs cleanup, but never duplicates a user message.
      let notifyFailure = !reviewFailureReplayed;
      if (scheduledDelivery) {
        const failedAt = new Date();
        if (!scheduledTelegramTargetMatches(channel.telegram, scheduledDelivery)) {
          // Never notify a target that was not approved for this run; close it without Telegram I/O.
          console.error(JSON.stringify({
            activeTelegramChatId: channel.telegram.chatId,
            activeTelegramMessageThreadId: channel.telegram.messageThreadId ?? null,
            code: SCHEDULED_TELEGRAM_TARGET_MISMATCH_CODE,
            expectedTelegramChatId: scheduledDelivery.telegramChatId,
            expectedTelegramMessageThreadId: scheduledDelivery.messageThreadId,
            runId: scheduledDelivery.runId,
            turnErrorCode: data.code,
          }));
          await agentScheduleDispatchRepository.failRun(
            sessionId,
            ctx.session.id,
            SCHEDULED_TELEGRAM_TARGET_MISMATCH_CODE,
            failedAt,
          );
          notifyFailure = false;
        } else {
          notifyFailure = await agentScheduleDispatchRepository.failRunForNotification(
            {
              applicationSessionId: sessionId,
              eveSessionId: ctx.session.id,
              familyId: scheduledDelivery.familyId,
              groupId: scheduledDelivery.groupId,
              messageThreadId: scheduledDelivery.messageThreadId,
              ownerUserId: scheduledDelivery.ownerUserId,
              runId: scheduledDelivery.runId,
              scope: scheduledDelivery.scope,
              telegramChatId: scheduledDelivery.telegramChatId,
            },
            data.code,
            failedAt,
          );
        }
      }
      // Terminal diagnostics are private-only even when the failed turn belonged to a shared chat.
      notifyFailure = notifyFailure && shouldNotifyTelegramFailure(channel);
      // A final send that started may already be visible; never append a second failure message.
      const finalDeliveryMayBeVisible = notifyFailure &&
        await telegramFinalDeliveryRepository.shouldSuppressFailureMessage(
          ctx.session.id,
          ctx.session.turn.id,
        );
      if (!finalDeliveryMayBeVisible && notifyFailure) {
        const replyParameters = isScheduledSession(ctx)
          ? undefined
          : telegramTurnReplyParameters(channel.state, ctx);
        const failureMessageId = await postTelegramMessageWithoutContinuationChange(channel, {
          ...(replyParameters === undefined ? {} : { reply_parameters: replyParameters }),
          text: formatTelegramTurnFailure(data),
        });
        if (!isScheduledSession(ctx)) {
          await registerTelegramDeliveredMessageRoutes(channel, ctx, [failureMessageId]);
        }
      }
      if (!reviewBatchId) await sessionRepository.recordTurnFailed(sessionId, ctx.session.id);
      await telegramHitlApprovalRepository.clearForEveSession(sessionId, ctx.session.id);
    },
    async "turn.started"(_data, _channel, ctx) {
      const sessionId = applicationSessionId(ctx);
      await sessionRepository.bindEveSession(sessionId, ctx.session.id);
      const reviewBatchId = memoryReviewBatchId(ctx);
      if (reviewBatchId) {
        await memoryReviewRepository.bindEveTurn({
          applicationSessionId: sessionId,
          batchId: reviewBatchId,
          eveSessionId: ctx.session.id,
          eveTurnId: ctx.session.turn.id,
        });
      }
      // This immutable snapshot survives every later model/tool/HITL step in the same durable turn.
      await bindMemoryTurnSources(ctx);
      const attributes = ctx.session.auth.current?.attributes;
      const timelineSequence = attributes?.telegramTimelineSequence;
      if (typeof timelineSequence === "string") {
        await groupTimelineCursorRepository.advance(
          sessionId,
          ctx.session.id,
          timelineSequence,
        );
      }
      const proactiveDeliveryCursor = attributes?.proactiveDeliveryCursor;
      if (typeof proactiveDeliveryCursor === "string") {
        await proactiveDeliveryRepository.advanceSessionCursor(
          sessionId,
          proactiveDeliveryCursor,
        );
      }
    },
    async "turn.completed"(_data, channel, ctx) {
      const sessionId = applicationSessionId(ctx);
      const awaitingApproval = await sessionRepository.hasPendingOperation(sessionId, ctx.session.id);
      if (!awaitingApproval) {
        // Evidence is durable at the terminal boundary; a parked HITL turn retains its source set.
        await releaseMemoryTurnSources(ctx);
        const reviewBatchId = memoryReviewBatchId(ctx);
        if (reviewBatchId) {
          await memoryReviewRepository.completeBatch({
            batchId: reviewBatchId,
            completedAt: new Date(),
            eveSessionId: ctx.session.id,
            eveTurnId: ctx.session.turn.id,
          });
        }
      }
      if (isScheduledSession(ctx) && !awaitingApproval) {
        // Successful scheduled runs are completed atomically with Telegram delivery above.
        await agentScheduleDispatchRepository.failRun(
          sessionId,
          ctx.session.id,
          "AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING",
          new Date(),
        );
      }
      if (!memoryReviewBatchId(ctx)) {
        await sessionRepository.recordTurnCompleted(sessionId, ctx.session.id, awaitingApproval);
      }
      if (!awaitingApproval) {
        await telegramHitlApprovalRepository.clearForEveSession(sessionId, ctx.session.id);
      }
    },
    async "authorization.required"(_data, _channel, ctx) {
      const sessionId = applicationSessionId(ctx);
      const auth = ctx.session.auth.current;
      const telegramUserId = auth?.attributes.telegramUserId;
      await sessionRepository.parkSession({
        applicationSessionId: sessionId,
        pendingRequestId: null,
        requesterTelegramUserId: typeof telegramUserId === "string" ? telegramUserId : null,
        requesterUserId: auth && UUID_PATTERN.test(auth.principalId) ? auth.principalId : null,
      });
    },
    async "authorization.completed"(_data, _channel, ctx) {
      await sessionRepository.resumePendingSession(applicationSessionId(ctx), ctx.session.id);
    },
  },
  onDrain: handleTelegramDurableIngress.drain,
  onHitlCallbackQuery: authorizeTelegramHitlCallback,
  onMessage: handleTelegramMessage,
  onVerifiedUpdate: handleTelegramDurableIngress,
  // The application persists authorized files before dispatch. The primary model receives only
  // trusted workspace paths and invokes the dedicated vision model when image analysis is needed.
  uploadPolicy: TELEGRAM_EVE_UPLOAD_POLICY,
});
