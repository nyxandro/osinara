/**
 * Scheduled session helpers for Telegram event handlers.
 *
 * Exports:
 * - `ScheduledDeliveryMetadata`: trusted persistence fields for a completed scheduled output.
 * - `scheduledDeliveryMetadata`: validates delivery metadata from scheduled-session auth.
 * - `scheduledRunId`: returns the trusted scheduled run id from current or initiator auth.
 * - `scheduledRunIdFromContinuationToken`: recovers a run id at the context-free session failure boundary.
 * - `isScheduledSession`: identifies background agent runs that should suppress progress UI.
 */
import type { SessionContext } from "../../runtime/context.js";

import { AppError } from "../app-error.js";

// Turn event contexts expose a channel-local Telegram address without the runtime namespace.
const SCHEDULED_CONTINUATION_PATTERN = /^[^:]+:[^:]*:schedule:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;

export interface ScheduledDeliveryMetadata {
  applicationSessionId: string;
  familyId: string;
  forumTopicId: string | null;
  groupId: string | null;
  messageThreadId: string | null;
  ownerUserId: string | null;
  runId: string;
  scheduledFor: string;
  scope: "family" | "group" | "personal";
  telegramChatId: string;
  title: string;
}

function runIdFromAttributes(attributes: Readonly<Record<string, unknown>> | undefined): string | null {
  const runId = attributes?.scheduledRunId;
  return typeof runId === "string" && runId ? runId : null;
}

export function scheduledRunId(ctx: { session: { auth: SessionContext["session"]["auth"] } }): string | null {
  return runIdFromAttributes(ctx.session.auth.current?.attributes) ??
    runIdFromAttributes(ctx.session.auth.initiator?.attributes);
}

export function scheduledRunIdFromContinuationToken(token: string): string | null {
  return SCHEDULED_CONTINUATION_PATTERN.exec(token)?.[1] ?? null;
}

export function isScheduledSession(ctx: { session: { auth: SessionContext["session"]["auth"] } }): boolean {
  return scheduledRunId(ctx) !== null;
}

export function scheduledDeliveryMetadata(
  ctx: { session: { auth: SessionContext["session"]["auth"] } },
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
  const applicationSessionId = attributes?.applicationSessionId;
  const telegramChatId = attributes?.telegramChatId;
  const scheduledFor = attributes?.scheduleScheduledFor;
  const title = attributes?.scheduleTitle;
  const principalId = scheduledAuth.principalId;
  if (
    typeof applicationSessionId !== "string" ||
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
  const groupType = attributes?.groupType;
  const groupScope = groupType === "external" ? "group" : "family";
  if (
    (!personal && !groupId) ||
    (personal && groupId) ||
    (!personal && groupType !== "external" && groupType !== "family_private")
  ) {
    throw new AppError(
      "AGENT_SCHEDULE_DELIVERY_SCOPE_INVALID",
      "Область результата агентного расписания не соответствует чату",
    );
  }
  return {
    applicationSessionId,
    familyId,
    forumTopicId: typeof attributes?.telegramForumTopicId === "string"
      ? attributes.telegramForumTopicId
      : null,
    groupId,
    messageThreadId: typeof attributes?.telegramMessageThreadId === "string"
      ? attributes.telegramMessageThreadId
      : null,
    ownerUserId: personal ? principalId : null,
    runId,
    scheduledFor,
    scope: personal ? "personal" : groupScope,
    telegramChatId,
    title,
  };
}
