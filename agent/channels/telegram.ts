/**
 * Eve Telegram channel.
 *
 * Constructs:
 * - Verified webhook transport with durable PostgreSQL ingress.
 * - Application-owned family/group authorization in `onMessage`.
 * - Durable identity-bound HITL callbacks and replies.
 * - Validated attachment persistence with model-safe workspace references.
 * - Native RichBlockThinking, chat-scoped streaming, and completed Rich Message delivery.
 * - Verified group replies anchored to the triggering member message.
 */
import { telegramChannel } from "eve/channels/telegram";

import { handleTelegramDurableIngress } from "../lib/telegram-durable-ingress.js";
import { formatTelegramTurnFailure } from "../lib/telegram-interface.js";
import { TELEGRAM_EVE_UPLOAD_POLICY } from "../lib/telegram-message-policy.js";
import { handleTelegramMessage } from "../lib/telegram-on-message.js";
import { completedTelegramMessage } from "../lib/telegram-progress.js";
import {
  postTelegramRichMessage,
  startTelegramRichThinkingDraft,
  streamTelegramRichMessageDraft,
} from "../lib/telegram-rich-messages.js";
import {
  applicationSessionId,
  rekeyTelegramSession,
} from "../lib/sessions/session-context.js";
import { sessionRepository } from "../lib/sessions/session-repository.js";
import { authorizeTelegramHitlCallback } from "../lib/telegram-hitl/callback-authorization.js";
import { handleTelegramInputRequested } from "../lib/telegram-hitl/input-request.js";
import { telegramHitlApprovalRepository } from "../lib/telegram-hitl/approval-repository.js";
import { handleTelegramSessionFailure } from "../lib/telegram-session-failure.js";
import { telegramTurnReplyParameters } from "../lib/telegram-reply.js";

export default telegramChannel({
  botUsername: process.env.TELEGRAM_BOT_USERNAME as string,
  credentials: {
    webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN as string,
  },
  drainRoute: "/eve/v1/telegram-drain",
  events: {
    async "action.result"(_data, channel) {
      // Refresh the same chat-scoped preview before the next model step.
      await startTelegramRichThinkingDraft(channel.telegram);
    },
    async "actions.requested"(_data, channel) {
      await startTelegramRichThinkingDraft(channel.telegram);
    },
    "input.requested": handleTelegramInputRequested,
    async "message.completed"(data, channel, ctx) {
      // Model-authored pre-tool text is a user-visible progress update, not technical tool noise.
      const message = completedTelegramMessage(data);
      if (!message) return;
      const sessionId = applicationSessionId(ctx);
      if (!await sessionRepository.isCurrentEveSession(sessionId, ctx.session.id)) return;
      await postTelegramRichMessage(
        message,
        channel.telegram,
        channel.state,
        telegramTurnReplyParameters(channel.state, ctx),
      );
      await rekeyTelegramSession(channel, ctx);
    },
    async "message.appended"(data, channel, ctx) {
      // Every turn and tool-loop step updates one Telegram preview for this private chat/topic.
      const sessionId = applicationSessionId(ctx);
      if (!await sessionRepository.isCurrentEveSession(sessionId, ctx.session.id)) return;
      await streamTelegramRichMessageDraft(data, channel.telegram);
    },
    async "session.failed"(data, channel) {
      await handleTelegramSessionFailure(data, channel, sessionRepository);
    },
    async "turn.failed"(data, channel, ctx) {
      const sessionId = applicationSessionId(ctx);
      // Eve's Telegram post helper updates both state and the durable continuation token.
      const replyParameters = telegramTurnReplyParameters(channel.state, ctx);
      await channel.telegram.post({
        ...(replyParameters === undefined ? {} : { reply_parameters: replyParameters }),
        text: formatTelegramTurnFailure(data),
      });
      await sessionRepository.recordTurnFailed(sessionId, ctx.session.id);
      await telegramHitlApprovalRepository.clearForEveSession(sessionId, ctx.session.id);
      await rekeyTelegramSession(channel, ctx);
    },
    async "turn.started"(_data, channel, ctx) {
      const sessionId = applicationSessionId(ctx);
      await sessionRepository.bindEveSession(sessionId, ctx.session.id);
      await startTelegramRichThinkingDraft(channel.telegram);
    },
    async "turn.completed"(_data, channel, ctx) {
      const sessionId = applicationSessionId(ctx);
      const awaitingApproval = await telegramHitlApprovalRepository.hasPendingForSession(
        sessionId,
        ctx.session.id,
      );
      await sessionRepository.recordTurnCompleted(sessionId, ctx.session.id, awaitingApproval);
      if (!awaitingApproval) {
        await telegramHitlApprovalRepository.clearForEveSession(sessionId, ctx.session.id);
      }
      await rekeyTelegramSession(channel, ctx);
    },
    async "authorization.required"(_data, channel, ctx) {
      const sessionId = applicationSessionId(ctx);
      await sessionRepository.markPendingOperation(sessionId, true);
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
