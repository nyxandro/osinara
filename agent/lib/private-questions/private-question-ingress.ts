/**
 * Private questions inside the durable Telegram ingress (#467).
 *
 * Exports:
 * - `PrivateQuestionIngress`: what the ingress needs — recognize the update, its own queue key, the arrival
 *   step right after storage, processing in the queue, and closing a question whose processing broke.
 * - `createPrivateQuestionIngress`: the production composition over PostgreSQL, Telegram and the runtime.
 *
 * Key constructs:
 * - An ephemeral update never takes the group's path: it is not journaled, not shown to memory review and does
 *   not settle the person's reply buttons.
 * - Its queue is "this person in this chat or topic" and starts with the chat id, so a group's removal purges
 *   its raw copies with the rest.
 */
import type { Pool } from "pg";

import type { JsonObject } from "../../runtime/json.js";
import { startChannelTurn } from "../../runtime/session/channel-session.js";
import type { TurnOutcome } from "../../runtime/turn/run-turn.js";
import { telegramContinuationToken } from "../../runtime/telegram/api.js";
import type { JournalDatabase } from "../../runtime/turn/journal-repository.js";
import { conversationRepository } from "../conversation-repository.js";
import { database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { selectTelegramGroupJournalContext } from "../telegram-group-journal-context.js";
import { telegramGroupJournalRepository } from "../telegram-group-journal-repository.js";
import { telegramRepository } from "../telegram-repository.js";
import { createPrivateQuestionArrival } from "./private-question-arrival.js";
import { isEphemeralGroupMessage, parsePrivateQuestion } from "./private-question-message.js";
import { privateQuestionStore } from "./private-question-repository.js";
import { privateQuestionTelegram } from "./private-question-telegram.js";
import { PRIVATE_QUESTION_TEXTS } from "./private-question-texts.js";
import {
  createPrivateQuestionTurns,
  PRIVATE_QUESTION_CHANNEL_KIND,
  PRIVATE_QUESTION_TIMELINE_LIMITS,
} from "./private-question-turn.js";

export interface PrivateQuestionIngress {
  isPrivate(raw: Record<string, unknown>): boolean;
  queueKey(raw: Record<string, unknown>): string;
  /** Runs right after the update is stored; never rejects, a failure is logged and the queue decides again. */
  arrive(raw: Record<string, unknown>, updateId: string): Promise<void>;
  /** Runs the question's turn in the queue; the agent session it ran in, or null when nothing ran. */
  process(raw: Record<string, unknown>, updateId: string): Promise<string | null>;
  fail(updateId: string, code: string): Promise<void>;
}

const RUNNING_STATES = new Set(["placeholder_sent", "answering"]);

export function createPrivateQuestionIngress(runtime: {
  readonly database: JournalDatabase & Pick<Pool, "query">;
  readonly runTurn: (turnId: string) => Promise<TurnOutcome>;
}): PrivateQuestionIngress {
  const arrival = createPrivateQuestionArrival({
    findGroup: (chatId, chatType) => telegramRepository.findGroup(chatId, chatType),
    findIdentity: (telegramUserId) => telegramRepository.findIdentity(telegramUserId),
    now: () => Date.now(),
    async readPhase() {
      const result = await database().query<{ phase: string }>("SELECT phase FROM runtime_maintenance WHERE singleton");
      const phase = result.rows[0]?.phase;
      if (!phase) throw new Error("AGENT_RUNTIME_MAINTENANCE_MISSING: runtime admission phase is unknown");
      return phase;
    },
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    store: privateQuestionStore,
    telegram: privateQuestionTelegram,
  });
  const runPrivateQuestion = createPrivateQuestionTurns({
    conversationId: async (groupId) => (await conversationRepository.getByGroupId(groupId)).id,
    findGroup: (chatId, chatType) => telegramRepository.findGroup(chatId, chatType),
    findIdentity: (telegramUserId) => telegramRepository.findIdentity(telegramUserId),
    async findStartedTurn(token) {
      const result = await runtime.database.query<{ session_id: string; turn_id: string }>(
        `SELECT turns.session_id, turns.id AS turn_id
           FROM agent_continuations AS continuation
           JOIN agent_turns AS turns ON turns.session_id = continuation.session_id
          WHERE continuation.token = $1 AND continuation.channel_kind = $2
          ORDER BY turns.sequence DESC LIMIT 1`,
        [token, PRIVATE_QUESTION_CHANNEL_KIND],
      );
      const row = result.rows[0];
      return row ? { sessionId: row.session_id, turnId: row.turn_id } : null;
    },
    async lastNewContextAt(groupId) {
      const result = await database().query<{ at: Date | null }>(
        "SELECT max(rotation_requested_at) AS at FROM conversation_sessions WHERE group_id = $1 AND kind = 'canonical'",
        [groupId],
      );
      return result.rows[0]?.at ?? null;
    },
    now: () => new Date(),
    prepareSession: (input) => sessionRepository.prepareTurn(input),
    runTurn: runtime.runTurn,
    async startTurn(input) {
      return await startChannelTurn(runtime.database, {
        auth: input.auth,
        channel: { kind: PRIVATE_QUESTION_CHANNEL_KIND },
        channelState: null,
        input: { context: [...input.context], message: input.message },
        kind: "conversation",
        token: input.token,
      });
    },
    store: privateQuestionStore,
    async timeline(groupId, threadId) {
      const entries = await telegramGroupJournalRepository.listRecent({
        anchorEntryId: null,
        beforeSequence: null,
        groupId,
        limit: PRIVATE_QUESTION_TIMELINE_LIMITS.messages,
        messageThreadId: threadId === null ? null : String(threadId),
      });
      return selectTelegramGroupJournalContext(
        entries, PRIVATE_QUESTION_TIMELINE_LIMITS.characters, null, null, PRIVATE_QUESTION_TIMELINE_LIMITS.messages,
      ).context;
    },
  });

  return {
    isPrivate: (raw) => isEphemeralGroupMessage(raw),

    queueKey(raw) {
      const message = (raw as { message: JsonObject & { chat: { id: number | string }; from?: { id?: number } } }).message;
      const question = parsePrivateQuestion(raw);
      const thread = question?.threadId ?? undefined;
      // An ephemeral message that is not a person's command still needs a queue of its own, apart from the group's.
      const sender = question?.telegramUserId ?? String(message.from?.id ?? "unknown");
      return telegramContinuationToken({
        chatId: String(message.chat.id),
        conversationId: `private-question-${sender}`,
        ...(thread === undefined ? {} : { messageThreadId: thread }),
      });
    },

    async arrive(raw, updateId) {
      try {
        await arrival.arrive(raw, updateId);
      } catch (error) {
        // The queue runs the same step again before any turn, so a failure here loses nothing.
        console.error(JSON.stringify({
          code: "AGENT_PRIVATE_QUESTION_ARRIVAL_FAILED", error: error instanceof Error ? error.message : String(error), updateId,
        }));
      }
    },

    async process(raw, updateId) {
      const outcome = await arrival.arrive(raw, updateId);
      if (outcome === "ignored") {
        // The group was disconnected or removed after the question arrived: close it without a word, as the
        // bot is silent in such a group (#465); Telegram would refuse the edit anyway.
        const stranded = await privateQuestionStore.findByUpdate(updateId);
        if (stranded !== null && RUNNING_STATES.has(stranded.state)) {
          await privateQuestionStore.changeById(stranded.id, { code: "AGENT_PRIVATE_QUESTION_GROUP_GONE", state: "failed" });
        }
        return null;
      }
      if (!RUNNING_STATES.has(outcome)) return null;
      const row = await privateQuestionStore.findByUpdate(updateId);
      const question = parsePrivateQuestion(raw);
      if (row === null || question === null) return null;
      const chatType = (raw.message as { chat: { type: "group" | "supergroup" } }).chat.type;
      const result = await runPrivateQuestion(row, { chatType, name: question.firstName });
      if ("sessionId" in result) return result.sessionId;
      if (row.placeholderEphemeralMessageId !== null) {
        try {
          await privateQuestionTelegram.edit({
            chatId: row.telegramChatId,
            content: { text: PRIVATE_QUESTION_TEXTS.notAllowed },
            ephemeralMessageId: row.placeholderEphemeralMessageId,
            receiverUserId: row.telegramUserId,
          });
        } catch (error) {
          // A group disconnected meanwhile refuses every write; the question is already closed as refused.
          console.warn(JSON.stringify({
            code: "AGENT_PRIVATE_QUESTION_REFUSAL_NOTICE_FAILED", error: error instanceof Error ? error.message : String(error), updateId,
          }));
        }
      }
      return null;
    },

    fail: (updateId, code) => arrival.fail(updateId, code),
  };
}
