/**
 * The turn of a private question: verified identity, a one-off session and what the model sees (#467).
 *
 * Exports:
 * - `PRIVATE_QUESTION_CHANNEL_KIND`: the channel the turn runs in; nothing of the Telegram group channel
 *   (timeline, reply anchor, typing, reactions, progress notices) exists there.
 * - `privateQuestionToken`: the turn's continuation token, one per question.
 * - `PrivateQuestionTurnDependencies`, `createPrivateQuestionTurns`: starts a question's turn, or finds the one
 *   a previous attempt already started, and runs it to its end.
 *
 * Key constructs:
 * - Rights are checked again at the start, from the current registration and identity: a group disconnected
 *   or switched to "only the owner" since the question arrived gets no turn.
 * - The session is one-off (`scheduled` kind: retired after its turn, deleted after a day). Earlier private
 *   exchanges of the same person in the same chat and topic come from the question store, as untrusted data,
 *   and only those after the group's last new context.
 * - A process that died after starting the turn finds it again by the token instead of starting a second one.
 */
import type { SessionAuthContext } from "../../runtime/context.js";
import type { TurnOutcome } from "../../runtime/turn/run-turn.js";
import {
  PRIVATE_QUESTION_RECENT_EXCHANGES,
  PRIVATE_QUESTION_RETENTION_MS,
  TELEGRAM_GROUP_JOURNAL_CONTEXT_CHARACTERS,
  TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES,
} from "../../config.js";
import { formatCurrentTimeContext } from "../current-time.js";
import { evaluateConversationAccess, type FamilyIdentity, type RegisteredGroup } from "../family-access.js";
import type { PreparedSession, PrepareSessionInput } from "../sessions/session-repository.js";
import { telegramSessionScope } from "../telegram-on-message-context.js";
import { escapeUntrustedContextJson } from "../untrusted-context-json.js";
import type { PrivateQuestionRow, PrivateQuestionStore, RecentPrivateExchange } from "./private-question-repository.js";
import { PRIVATE_QUESTION_CODES } from "./private-question-texts.js";

export const PRIVATE_QUESTION_CHANNEL_KIND = "private-question";

export function privateQuestionToken(questionId: string): string {
  return `private-question:${questionId}`;
}

export interface PrivateQuestionTurnDependencies {
  /** The current registration of a connected group; null when it is gone or disconnected. */
  findGroup(telegramChatId: string, chatType: "group" | "supergroup"): Promise<RegisteredGroup | null>;
  findIdentity(telegramUserId: string): Promise<FamilyIdentity | null>;
  /** The group's application conversation, whose notes and memory selection the turn reads. */
  conversationId(groupId: string): Promise<string>;
  /** When the group last started a new context, or null if never. */
  lastNewContextAt(groupId: string): Promise<Date | null>;
  /** The recent shared timeline of the chat or topic, already wrapped as untrusted, or null if empty. */
  timeline(groupId: string, threadId: number | null): Promise<string | null>;
  prepareSession(input: PrepareSessionInput): Promise<PreparedSession>;
  findStartedTurn(token: string): Promise<{ readonly sessionId: string; readonly turnId: string } | null>;
  startTurn(input: {
    readonly auth: SessionAuthContext;
    readonly context: readonly string[];
    readonly message: string;
    readonly token: string;
  }): Promise<{ readonly sessionId: string; readonly turnId: string }>;
  runTurn(turnId: string): Promise<TurnOutcome>;
  now(): Date;
  store: Pick<PrivateQuestionStore, "changeById" | "recentExchanges">;
}

function exchangesBlock(exchanges: readonly RecentPrivateExchange[]): string | null {
  if (exchanges.length === 0) return null;
  const oldestFirst = [...exchanges].reverse().map((exchange) => ({
    answer: exchange.answer,
    askedAt: exchange.receivedAt.toISOString(),
    question: exchange.question,
  }));
  return [
    "<untrusted_previous_private_exchanges>",
    escapeUntrustedContextJson(oldestFirst),
    "</untrusted_previous_private_exchanges>",
  ].join("\n");
}

function questionMessage(senderName: string, question: string): string {
  return [
    "<private_question>",
    escapeUntrustedContextJson({ senderDisplayName: senderName, text: question }),
    "</private_question>",
  ].join("\n");
}

export function createPrivateQuestionTurns(dependencies: PrivateQuestionTurnDependencies) {
  /**
   * Runs the question's turn to its end and returns the agent session, or null when no turn may run: the
   * question is then closed as refused, and its «Думаю…» is turned into the refusal by the caller.
   */
  return async function runPrivateQuestion(
    row: PrivateQuestionRow,
    sender: { readonly chatType: "group" | "supergroup"; readonly name: string },
  ): Promise<{ readonly sessionId: string } | { readonly refused: string }> {
    const token = privateQuestionToken(row.id);
    const started = await dependencies.findStartedTurn(token);
    if (started !== null) {
      await dependencies.runTurn(started.turnId);
      return { sessionId: started.sessionId };
    }
    const group = await dependencies.findGroup(row.telegramChatId, sender.chatType);
    const identity = await dependencies.findIdentity(row.telegramUserId);
    const decision = group === null ? null : evaluateConversationAccess({
      actorKind: "telegram_user",
      chat: { id: row.telegramChatId, type: sender.chatType },
      identity,
      registeredGroup: group,
    });
    const isOwner = group !== null && identity?.familyId === group.familyId && identity.role === "owner";
    if (group === null || group.groupId !== row.groupId || decision === null || !decision.allowed || (group.messageMode === "owner_only" && !isOwner)) {
      await dependencies.store.changeById(row.id, { code: PRIVATE_QUESTION_CODES.notAllowed, state: "refused" });
      return { refused: PRIVATE_QUESTION_CODES.notAllowed };
    }
    await dependencies.store.changeById(row.id, { state: "answering" });
    const now = dependencies.now();
    const access = decision.access;
    const session = await dependencies.prepareSession({
      baseContinuationToken: token,
      familyId: access.familyId,
      kind: "scheduled",
      now,
      telegramForumTopicId: row.threadId,
      ...telegramSessionScope(decision),
    });
    const conversationId = await dependencies.conversationId(group.groupId);
    const newContextAt = await dependencies.lastNewContextAt(group.groupId);
    const dayAgo = new Date(now.getTime() - PRIVATE_QUESTION_RETENTION_MS);
    const exchanges = await dependencies.store.recentExchanges({
      excludeId: row.id,
      groupId: group.groupId,
      limit: PRIVATE_QUESTION_RECENT_EXCHANGES,
      since: newContextAt !== null && newContextAt > dayAgo ? newContextAt : dayAgo,
      telegramUserId: row.telegramUserId,
      threadId: row.threadId,
    });
    const auth: SessionAuthContext = {
      attributes: {
        applicationSessionId: session.id,
        familyId: access.familyId,
        groupId: group.groupId,
        groupType: group.type,
        memoryScopes: access.memoryScopes,
        privateQuestion: "true",
        privateQuestionId: row.id,
        privateQuestionSenderName: sender.name,
        role: access.role,
        sandboxSessionId: session.sandboxSessionId,
        skillAllowlist: [],
        telegramActorId: row.telegramUserId,
        telegramActorKind: "telegram_user",
        telegramChatId: row.telegramChatId,
        telegramChatType: sender.chatType,
        telegramConversationId: conversationId,
        ...(row.threadId === null ? {} : { telegramForumTopicId: String(row.threadId) }),
        telegramTurnStartedAt: now.toISOString(),
        telegramUserId: row.telegramUserId,
        ...(group.type === "external" ? { toolAllowlist: group.toolAllowlist } : {}),
      },
      authenticator: "telegram",
      principalId: access.userId ?? `telegram:${row.telegramUserId}`,
      principalType: "user",
    };
    const turn = await dependencies.startTurn({
      auth,
      // The timeline and earlier exchanges are context, not the message: the memory selection searches by the
      // message, and it must search by what was asked, not by twelve thousand characters of the chat.
      context: [
        `Verified turn: scope ${access.memoryScopes.join(", ")}; role ${access.role}; actor telegram_user; private question.`,
        formatCurrentTimeContext(now),
        ...[await dependencies.timeline(group.groupId, row.threadId), exchangesBlock(exchanges)]
          .filter((part): part is string => part !== null),
      ],
      message: questionMessage(sender.name, row.question),
      token,
    });
    await dependencies.runTurn(turn.turnId);
    return { sessionId: turn.sessionId };
  };
}

/** The timeline limits a group turn uses; the private question reads the same window of the chat. */
export const PRIVATE_QUESTION_TIMELINE_LIMITS = Object.freeze({
  characters: TELEGRAM_GROUP_JOURNAL_CONTEXT_CHARACTERS,
  messages: TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES,
});
