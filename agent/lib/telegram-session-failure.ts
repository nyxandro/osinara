/**
 * Telegram terminal session failure handling.
 *
 * Export:
 * - `isHookConflictFailure`: identifies Eve's expected competing-root ownership rejection.
 * - `handleTelegramSessionFailure`: records failures and reports them only to private chats.
 */
import type { TelegramEventContext } from "eve/channels/telegram";

import { formatTelegramSessionFailure } from "./telegram-interface.js";
import { AppError } from "./app-error.js";
import type { SessionEventResult } from "./sessions/session-eve-event.js";
import type { sessionRepository } from "./sessions/session-repository.js";
import { scheduledRunIdFromContinuationToken } from "./agent-schedules/scheduled-session.js";
import type { agentScheduleDispatchRepository } from "./agent-schedules/agent-schedule-dispatch-repository.js";
import { postTelegramMessageWithoutContinuationChange } from "./telegram-stable-delivery.js";
import { shouldNotifyTelegramFailure } from "./telegram-failure-notification.js";

interface SessionFailureData {
  code: string;
  details?: Readonly<Record<string, unknown>>;
  message: string;
  sessionId: string;
}

type SessionFailureRepository = Pick<
  typeof sessionRepository,
  "recordSessionFailedByContinuationToken"
>;
type ScheduleFailureRepository = Pick<
  typeof agentScheduleDispatchRepository,
  "failRunByIdentityForNotification"
>;

function requiredTelegramContinuationToken(channel: TelegramEventContext): string {
  // Eve 0.32 exposes only the channel-local address; failure ownership cannot be inferred without it.
  const token = channel.continuation?.token;
  if (!token) {
    throw new AppError(
      "AGENT_SESSION_CONTINUATION_INVALID",
      "Не удалось определить маршрут повреждённого Telegram-контекста",
    );
  }
  return token;
}

export function isHookConflictFailure(data: SessionFailureData): boolean {
  // Eve serializes unrecognized workflow errors into `details`; accept the exact class identity
  // in either stable code position without classifying arbitrary message text as a conflict.
  return data.code === "HookConflictError" || data.details?.name === "HookConflictError";
}

export async function handleTelegramSessionFailure(
  data: SessionFailureData,
  channel: TelegramEventContext,
  repository: SessionFailureRepository,
  scheduleRepository: ScheduleFailureRepository,
): Promise<void> {
  // A competing root loses hook ownership by design; the existing owner is healthy and must not
  // be rotated or shown a terminal failure produced by the rejected competitor.
  if (isHookConflictFailure(data)) return;
  const continuationToken = requiredTelegramContinuationToken(channel);
  const scheduledRunId = scheduledRunIdFromContinuationToken(continuationToken);
  const notifyScheduledFailure = scheduledRunId === null
    ? true
    : await scheduleRepository.failRunByIdentityForNotification(
        scheduledRunId,
        data.sessionId,
        data.code,
        new Date(),
      );
  const result = await repository.recordSessionFailedByContinuationToken(
    continuationToken,
    data.sessionId,
  ) as SessionEventResult;
  if (result === "stale") return;
  if (!notifyScheduledFailure) return;
  if (!shouldNotifyTelegramFailure(channel)) return;
  await postTelegramMessageWithoutContinuationChange(channel, formatTelegramSessionFailure(data));
}
