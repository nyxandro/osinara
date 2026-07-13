/**
 * Telegram terminal session failure handling.
 *
 * Export:
 * - `handleTelegramSessionFailure`: notifies the user and records the route from before Telegram re-anchors it.
 */
import type { TelegramEventContext } from "eve/channels/telegram";

import { formatTelegramSessionFailure } from "./telegram-interface.js";
import type { SessionEventResult } from "./sessions/session-eve-event.js";
import type { sessionRepository } from "./sessions/session-repository.js";

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

export async function handleTelegramSessionFailure(
  data: SessionFailureData,
  channel: TelegramEventContext,
  repository: SessionFailureRepository,
): Promise<void> {
  // Posting to a group changes the adapter token, so preserve the failing route first.
  const failedContinuationToken = channel.continuationToken;
  const result = await repository.recordSessionFailedByContinuationToken(
    failedContinuationToken,
    data.sessionId,
  ) as SessionEventResult;
  if (result === "stale") return;
  await channel.telegram.post(formatTelegramSessionFailure(data));
}
