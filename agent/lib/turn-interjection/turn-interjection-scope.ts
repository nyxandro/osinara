/**
 * Which turns may see messages that arrive while they work.
 *
 * Export:
 * - `resolveTurnInterjectionScope`: the verified sender, ingress update, conversation, and marker of
 *   an eligible turn.
 *
 * Only a root turn prepared from a Telegram message in a private chat or a family group qualifies:
 * its preparation announced the marker to the model. A scheduled run, a delegated child, a
 * background review, a button continuation, and an external group keep today's behavior: their
 * queue is not consulted at all.
 */
import type { SessionAuth } from "eve/context";

import { isScheduledSession } from "../agent-schedules/scheduled-session.js";

export const TURN_INTERJECTION_MARKER_ATTRIBUTE = "telegramTurnInterjectionMarker";

export interface TurnInterjectionScope {
  applicationSessionId: string;
  chatType: "group" | "private" | "supergroup";
  currentUpdateId: string;
  /** Registered family group, required to resolve the group's canonical route. */
  groupId: string | null;
  marker: string;
  telegramChatId: string;
  /** Verified forum topic of the turn, null for a chat without topics. */
  telegramForumTopicId: number | null;
  telegramUserId: string;
}

function forumTopic(value: unknown): number | null | undefined {
  if (value === undefined) return null;
  const parsed = typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveTurnInterjectionScope(
  ctx: { session: { auth: SessionAuth; parent?: unknown } },
): TurnInterjectionScope | null {
  if (ctx.session.parent !== undefined && ctx.session.parent !== null) return null;
  if (isScheduledSession(ctx)) return null;
  const attributes = ctx.session.auth.current?.attributes;
  if (!attributes || attributes.memoryReviewMode === "background") return null;
  const {
    applicationSessionId,
    osinaraTelegramUpdateId: currentUpdateId,
    telegramChatId,
    telegramChatType: chatType,
    telegramUserId,
  } = attributes;
  const marker = attributes[TURN_INTERJECTION_MARKER_ATTRIBUTE];
  if (
    typeof currentUpdateId !== "string" || typeof telegramUserId !== "string" ||
    typeof marker !== "string" || !marker || typeof applicationSessionId !== "string" ||
    typeof telegramChatId !== "string" || attributes.telegramActorKind !== "telegram_user"
  ) return null;
  const telegramForumTopicId = forumTopic(attributes.telegramForumTopicId);
  if (telegramForumTopicId === undefined) return null;
  const base = { applicationSessionId, currentUpdateId, marker, telegramChatId, telegramForumTopicId, telegramUserId };
  if (chatType === "private") {
    return attributes.groupType === undefined ? { ...base, chatType, groupId: null } : null;
  }
  if ((chatType === "group" || chatType === "supergroup") && attributes.groupType === "family_private" &&
    typeof attributes.groupId === "string") {
    return { ...base, chatType, groupId: attributes.groupId };
  }
  return null;
}
