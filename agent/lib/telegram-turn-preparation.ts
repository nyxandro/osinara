/**
 * Mandatory pre-model preparation of a Telegram turn: a failure here stops the turn before any
 * model call. The update's binding to its turn is written when the turn is created
 * (`telegram-ingress-dispatch.ts`), not here.
 */
import type { TelegramTurnEvents } from "../runtime/telegram/channel-types.js";
import { requireTelegramAdmissionDeadline } from "./telegram-ingress-dispatch.js";
import { applicationSessionId } from "./sessions/session-context.js";
import { sessionRepository } from "./sessions/session-repository.js";
import { groupTimelineCursorRepository } from "./sessions/group-timeline-cursor-repository.js";
import { refreshTelegramReactionPolicy } from "./telegram-reaction-policy.js";
import { isScheduledSession } from "./agent-schedules/scheduled-session.js";
import { memoryReviewBatchId } from "./memory-review/memory-review-session.js";
import { memoryReviewRepository } from "./memory-review/memory-review-repository.js";
import { bindMemoryTurnSources } from "./memory-turn-source.js";
import { proactiveDeliveryRepository } from "./proactive-deliveries/proactive-delivery-repository.js";
import { admitScheduledAgentTurn } from "./agent-schedules/agent-schedule-recovery.js";
import { admitConversationWakeupTurn } from "./conversation-wakeups/conversation-wakeup-events.js";

export const prepareTelegramTurn: TelegramTurnEvents["turn.started"] = async (_data, channel, ctx) => {
  requireTelegramAdmissionDeadline(ctx.session.auth);
  const sessionId = applicationSessionId(ctx);
  const scheduledRunId = ctx.session.auth.current?.attributes.scheduledRunId;
  if (!ctx.session.parent && typeof scheduledRunId === "string") await admitScheduledAgentTurn({
    runId: scheduledRunId, applicationSessionId: sessionId, eveSessionId: ctx.session.id, eveTurnId: ctx.session.turn.id,
  });
  await admitConversationWakeupTurn(ctx);
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
