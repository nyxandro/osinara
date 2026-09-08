/** Mandatory pre-model preparation, including durable ingress provenance. */
import type { TelegramChannelEvents } from "eve/channels/telegram";
import { requireTelegramAdmissionDeadline } from "./telegram-processing-deadline.js";
import { bindTelegramIngressTurn } from "./telegram-ingress-binding.js";
import { applicationSessionId } from "./sessions/session-context.js";
import { sessionRepository } from "./sessions/session-repository.js";
import { groupTimelineCursorRepository } from "./sessions/group-timeline-cursor-repository.js";
import { refreshTelegramReactionPolicy } from "./telegram-reaction-policy.js";
import { isScheduledSession } from "./agent-schedules/scheduled-session.js";
import { memoryReviewBatchId } from "./memory-review/memory-review-session.js";
import { memoryReviewRepository } from "./memory-review/memory-review-repository.js";
import { bindMemoryTurnSources } from "./memory-turn-source.js";
import { proactiveDeliveryRepository } from "./proactive-deliveries/proactive-delivery-repository.js";

export const prepareTelegramTurn: TelegramChannelEvents["turn.started"] = async (_data, channel, ctx) => {
  requireTelegramAdmissionDeadline(ctx.session.auth);
  if (!ctx.session.parent) await bindTelegramIngressTurn(ctx.session.auth, ctx.session.id, ctx.session.turn.id);
  const sessionId = applicationSessionId(ctx);
  await sessionRepository.bindEveSession(sessionId, ctx.session.id);
  // Provider reaction policy is refreshed for later instruction resolution, never guessed.
  if (!isScheduledSession(ctx)) await refreshTelegramReactionPolicy(channel.telegram);
  const reviewBatchId = memoryReviewBatchId(ctx);
  if (reviewBatchId) {
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: sessionId, batchId: reviewBatchId,
      eveSessionId: ctx.session.id, eveTurnId: ctx.session.turn.id,
    });
  }
  await bindMemoryTurnSources(ctx);
  const attributes = ctx.session.auth.current?.attributes;
  const timelineSequence = attributes?.telegramTimelineSequence;
  if (typeof timelineSequence === "string") await groupTimelineCursorRepository.advance(sessionId, ctx.session.id, timelineSequence);
  const proactiveDeliveryCursor = attributes?.proactiveDeliveryCursor;
  if (typeof proactiveDeliveryCursor === "string") await proactiveDeliveryRepository.advanceSessionCursor(sessionId, proactiveDeliveryCursor);
  requireTelegramAdmissionDeadline(ctx.session.auth);
};
