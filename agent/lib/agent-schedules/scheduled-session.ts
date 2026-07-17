/**
 * Scheduled Eve session helpers for Telegram event handlers.
 *
 * Exports:
 * - `ScheduledDeliveryMetadata`: trusted persistence fields for a completed scheduled output.
 * - `scheduledDeliveryMetadata`: validates delivery metadata from scheduled-session auth.
 * - `scheduledRunId`: returns the trusted scheduled run id from current or initiator auth.
 * - `isScheduledSession`: identifies background agent runs that should suppress progress UI.
 */
import type { SessionContext } from "eve/context";

import { AppError } from "../app-error.js";

export interface ScheduledDeliveryMetadata {
  familyId: string;
  groupId: string | null;
  messageThreadId: string | null;
  ownerUserId: string | null;
  runId: string;
  scheduledFor: string;
  scope: "family" | "personal";
  telegramChatId: string;
  title: string;
}

function runIdFromAttributes(attributes: Readonly<Record<string, unknown>> | undefined): string | null {
  const runId = attributes?.scheduledRunId;
  return typeof runId === "string" && runId ? runId : null;
}

export function scheduledRunId(ctx: Pick<SessionContext, "session">): string | null {
  return runIdFromAttributes(ctx.session.auth.current?.attributes) ??
    runIdFromAttributes(ctx.session.auth.initiator?.attributes);
}

export function isScheduledSession(ctx: Pick<SessionContext, "session">): boolean {
  return scheduledRunId(ctx) !== null;
}

export function scheduledDeliveryMetadata(
  ctx: Pick<SessionContext, "session">,
): ScheduledDeliveryMetadata | null {
  const current = ctx.session.auth.current;
  const initiator = ctx.session.auth.initiator;
  let scheduledAuth = runIdFromAttributes(current?.attributes) ? current : null;
  if (!scheduledAuth && runIdFromAttributes(initiator?.attributes)) scheduledAuth = initiator;
  if (!scheduledAuth) return null;
  const attributes = scheduledAuth.attributes;
  const runId = runIdFromAttributes(attributes)!;
  const scope = attributes?.memoryScopes;
  const personal = Array.isArray(scope) && scope.includes("personal");
  const familyId = attributes?.familyId;
  const telegramChatId = attributes?.telegramChatId;
  const scheduledFor = attributes?.scheduleScheduledFor;
  const title = attributes?.scheduleTitle;
  const principalId = scheduledAuth.principalId;
  if (
    typeof familyId !== "string" ||
    typeof telegramChatId !== "string" ||
    typeof scheduledFor !== "string" ||
    typeof title !== "string" ||
    typeof principalId !== "string"
  ) {
    throw new AppError(
      "AGENT_SCHEDULE_DELIVERY_CONTEXT_INVALID",
      "Не удалось сохранить результат агентного расписания",
    );
  }
  const groupId = typeof attributes?.groupId === "string" ? attributes.groupId : null;
  if ((!personal && !groupId) || (personal && groupId)) {
    throw new AppError(
      "AGENT_SCHEDULE_DELIVERY_SCOPE_INVALID",
      "Область результата агентного расписания не соответствует чату",
    );
  }
  return {
    familyId,
    groupId,
    messageThreadId: typeof attributes?.telegramMessageThreadId === "string"
      ? attributes.telegramMessageThreadId
      : null,
    ownerUserId: personal ? principalId : null,
    runId,
    scheduledFor,
    scope: personal ? "personal" : "family",
    telegramChatId,
    title,
  };
}
