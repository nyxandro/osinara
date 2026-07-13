/**
 * Eve Telegram channel.
 *
 * Constructs:
 * - Verified webhook transport with durable PostgreSQL ingress.
 * - Application-owned family/group authorization in `onMessage`.
 * - Verified image forwarding plus application-owned document persistence.
 * - Native real-time Telegram draft streaming for private chats.
 */
import {
  registerTelegramFreeformPrompt,
  renderTelegramInputRequest,
  telegramChannel,
} from "eve/channels/telegram";

import { TELEGRAM_MAX_INBOUND_ATTACHMENT_BYTES } from "../config.js";
import { handleTelegramDurableIngress } from "../lib/telegram-durable-ingress.js";
import { streamTelegramMessageDraft } from "../lib/telegram-draft-streaming.js";
import {
  formatTelegramSessionFailure,
  formatTelegramTurnFailure,
  localizeTelegramInputRequest,
  localizeTelegramReplyMarkup,
} from "../lib/telegram-interface.js";
import { handleTelegramMessage } from "../lib/telegram-on-message.js";
import { postTelegramMarkdown } from "../lib/telegram-markdown.js";
import { completedTelegramMessage } from "../lib/telegram-progress.js";
import {
  rekeyTelegramSession,
  resolveApplicationSessionId,
} from "../lib/sessions/session-context.js";
import { sessionRepository } from "../lib/sessions/session-repository.js";

export default telegramChannel({
  botUsername: process.env.TELEGRAM_BOT_USERNAME as string,
  credentials: {
    webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN as string,
  },
  drainRoute: "/eve/v1/telegram-drain",
  events: {
    async "input.requested"(data, channel, ctx) {
      const sessionId = await resolveApplicationSessionId(ctx, channel.continuationToken);
      await sessionRepository.markPendingOperation(sessionId, true);
      for (const request of data.requests) {
        const localizedRequest = localizeTelegramInputRequest(request);
        const rendered = renderTelegramInputRequest(localizedRequest, channel.state);
        const sent = await channel.telegram.post({
          reply_markup: localizeTelegramReplyMarkup(rendered.replyMarkup),
          text: rendered.text,
        });
        if (rendered.freeformRequestId && sent.id) {
          registerTelegramFreeformPrompt(channel.state, {
            messageId: sent.id,
            requestId: rendered.freeformRequestId,
          });
        }
      }
      await rekeyTelegramSession(channel, ctx);
    },
    async "message.completed"(data, channel, ctx) {
      // Model-authored pre-tool text is a user-visible progress update, not technical tool noise.
      const message = completedTelegramMessage(data);
      if (!message) return;
      const sessionId = await resolveApplicationSessionId(ctx, channel.continuationToken);
      if (!await sessionRepository.isCurrentEveSession(sessionId, ctx.session.id)) return;
      await postTelegramMarkdown(channel.telegram, message);
      await rekeyTelegramSession(channel, ctx);
    },
    async "message.appended"(data, channel, ctx) {
      // Eve already coalesces queued deltas under backpressure, so no artificial timer is needed.
      const sessionId = await resolveApplicationSessionId(ctx, channel.continuationToken);
      if (!await sessionRepository.isCurrentEveSession(sessionId, ctx.session.id)) return;
      await streamTelegramMessageDraft(data, channel.telegram);
    },
    async "session.failed"(data, channel) {
      await channel.telegram.post(formatTelegramSessionFailure(data));
      await sessionRepository.recordSessionFailedByContinuationToken(channel.continuationToken);
    },
    async "turn.failed"(data, channel, ctx) {
      const sessionId = await resolveApplicationSessionId(ctx, channel.continuationToken);
      // Eve's Telegram post helper updates both state and the durable continuation token.
      await channel.telegram.post(formatTelegramTurnFailure(data));
      await sessionRepository.recordTurnFailed(sessionId, ctx.session.id);
      await rekeyTelegramSession(channel, ctx);
    },
    async "turn.started"(_data, channel, ctx) {
      const sessionId = await resolveApplicationSessionId(ctx, channel.continuationToken);
      await sessionRepository.bindEveSession(sessionId, ctx.session.id);
    },
    async "turn.completed"(_data, channel, ctx) {
      const sessionId = await resolveApplicationSessionId(ctx, channel.continuationToken);
      await sessionRepository.recordTurnCompleted(sessionId, ctx.session.id);
      await rekeyTelegramSession(channel, ctx);
    },
    async "authorization.required"(_data, channel, ctx) {
      const sessionId = await resolveApplicationSessionId(ctx, channel.continuationToken);
      await sessionRepository.markPendingOperation(sessionId, true);
    },
  },
  onDrain: handleTelegramDurableIngress.drain,
  onMessage: handleTelegramMessage,
  onVerifiedUpdate: handleTelegramDurableIngress,
  resolveContinuationToken: (baseToken) => sessionRepository.resolveContinuationToken(baseToken),
  uploadPolicy: {
    // Groq Qwen accepts images but rejects non-image AI SDK file parts. Documents are already
    // verified and mounted by the application handler, so Eve forwards only images to vision.
    allowedMediaTypes: ["image/*"],
    maxBytes: TELEGRAM_MAX_INBOUND_ATTACHMENT_BYTES,
  },
});
