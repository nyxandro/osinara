/**
 * PostgreSQL state of reply-button sets.
 *
 * Exports:
 * - `ReplyButtonSet`: one stored set as the delivery, press and dismissal paths read it.
 * - `ReplyButtonPressClaim`: the outcome of claiming one press.
 * - `replyButtonRepository`: staging with the exact text of the message, activation once Telegram
 *   confirmed it, the press claim and the dismissal by the addressee's own message.
 *
 * Key constructs:
 * - Every set is staged together with the rich markdown of its message, so a settled caption is
 *   written under the same words.
 * - A press is claimed in one statement: only the addressee, only a set still offering its buttons,
 *   only once. The same callback query repeated after a crash finds its own claim again.
 * - A set whose message went out before its number was saved (a crash in between) still accepts
 *   its press: the token is unguessable and the chat must match, so the message comes from the press.
 * - A press on buttons already decided returns the set, so its message can be settled again when an
 *   earlier edit never landed.
 * - Dismissal touches only sets that were visible before the addressee's message was written:
 *   buttons the agent offered after it, in answer to it, stay.
 */
import { database } from "../database.js";
import type { ReplyButtonRows } from "./reply-button-contract.js";

// Buttons live only in rich messages; the column keeps the message's format explicit.
const RICH_MESSAGE_FORMAT = "rich";

export interface ReplyButtonSet {
  addresseeTelegramUserId: string;
  buttons: ReplyButtonRows;
  id: string;
  /** The rich markdown of the message without its buttons. */
  messageText: string | null;
  resolvedAt: Date | null;
  selectedIndex: number | null;
  status: "active" | "dismissed" | "selected" | "staged";
  telegramChatId: string;
  telegramChatType: "group" | "private" | "supergroup";
  telegramMessageId: string | null;
  token: string;
}

export type ReplyButtonPressClaim =
  | { set: ReplyButtonSet; status: "claimed" | "replayed" }
  | { decided?: ReplyButtonSet; status: "expired" }
  | { status: "forbidden" };

interface SetRow {
  addressee_telegram_user_id: string;
  buttons: ReplyButtonRows;
  id: string;
  message_text: string | null;
  resolved_at: Date | null;
  selected_index: number | null;
  status: ReplyButtonSet["status"];
  telegram_chat_id: string;
  telegram_chat_type: "group" | "private" | "supergroup";
  telegram_message_id: string | null;
  token: string;
}

const SET_COLUMNS = `id, token, telegram_chat_id, telegram_chat_type, addressee_telegram_user_id, buttons,
  telegram_message_id::text, message_text, selected_index, resolved_at, status`;

function toSet(row: SetRow): ReplyButtonSet {
  return {
    addresseeTelegramUserId: row.addressee_telegram_user_id,
    buttons: row.buttons,
    id: row.id,
    messageText: row.message_text,
    resolvedAt: row.resolved_at,
    selectedIndex: row.selected_index,
    status: row.status,
    telegramChatId: row.telegram_chat_id,
    telegramChatType: row.telegram_chat_type,
    telegramMessageId: row.telegram_message_id,
    token: row.token,
  };
}

interface ReplyButtonTarget {
  addresseeTelegramUserId: string;
  telegramChatId: string;
  telegramChatType: "group" | "private" | "supergroup";
}

export const replyButtonRepository = {
  /**
   * The buttons of a turn's final answer with the text of its last message. A replay of the same
   * delivery finds the set still staged and keeps its token, so the message it sends is the same.
   */
  async stageForTurn(input: ReplyButtonTarget & {
    agentSessionId: string;
    agentTurnId: string;
    buttons: ReplyButtonRows;
    messageText: string;
    token: string;
  }): Promise<ReplyButtonSet> {
    const result = await database().query<SetRow>(
      `INSERT INTO telegram_reply_button_sets
         (token, origin, agent_session_id, agent_turn_id, telegram_chat_id, telegram_chat_type,
          addressee_telegram_user_id, buttons, status, message_text, message_format)
       VALUES ($1, 'turn', $2, $3, $4, $5, $6, $7::jsonb, 'staged', $8, $9)
       ON CONFLICT (agent_turn_id) WHERE status = 'staged'
       DO UPDATE SET message_text = EXCLUDED.message_text
       RETURNING ${SET_COLUMNS}`,
      [input.token, input.agentSessionId, input.agentTurnId, input.telegramChatId, input.telegramChatType,
        input.addresseeTelegramUserId, JSON.stringify(input.buttons), input.messageText, RICH_MESSAGE_FORMAT],
    );
    return toSet(result.rows[0]!);
  },

  /** A reminder's buttons for one delivery: its text is known before the message is sent. */
  async stageForReminder(input: ReplyButtonTarget & {
    buttons: ReplyButtonRows;
    messageText: string;
    reminderId: string;
    token: string;
  }): Promise<ReplyButtonSet> {
    const result = await database().query<SetRow>(
      `INSERT INTO telegram_reply_button_sets
         (token, origin, reminder_id, telegram_chat_id, telegram_chat_type, addressee_telegram_user_id,
          buttons, status, message_text, message_format)
       VALUES ($1, 'reminder', $2, $3, $4, $5, $6::jsonb, 'staged', $7, $8)
       RETURNING ${SET_COLUMNS}`,
      [input.token, input.reminderId, input.telegramChatId, input.telegramChatType, input.addresseeTelegramUserId,
        JSON.stringify(input.buttons), input.messageText, RICH_MESSAGE_FORMAT],
    );
    return toSet(result.rows[0]!);
  },

  /**
   * A turn's answer is out: the buttons staged for it are offered under its last message. Nothing
   * happens when its buttons never went out with it, and a set pressed before this already holds
   * its message number.
   */
  async activateForTurn(agentTurnId: string, telegramMessageId: string): Promise<void> {
    await database().query(
      `UPDATE telegram_reply_button_sets
          SET telegram_message_id = coalesce(telegram_message_id, $2::bigint),
              status = 'active', activated_at = now()
        WHERE agent_turn_id = $1 AND status = 'staged'`,
      [agentTurnId, telegramMessageId],
    );
  },

  /** Telegram refused the message that carried these buttons: they never went out. */
  async discard(id: string): Promise<void> {
    await database().query("DELETE FROM telegram_reply_button_sets WHERE id = $1 AND status = 'staged'", [id]);
  },

  /** The message is out: its buttons are offered. A press that arrived first keeps its outcome. */
  async activate(id: string, telegramMessageId: string): Promise<void> {
    await database().query(
      `UPDATE telegram_reply_button_sets
          SET telegram_message_id = coalesce(telegram_message_id, $2::bigint),
              status = CASE WHEN status = 'staged' THEN 'active' ELSE status END,
              activated_at = CASE WHEN status = 'staged' THEN now() ELSE activated_at END
        WHERE id = $1`,
      [id, telegramMessageId],
    );
  },

  async claimPress(input: {
    callbackQueryId: string;
    index: number;
    pressedByTelegramUserId: string;
    telegramChatId: string;
    telegramMessageId: string;
    token: string;
  }): Promise<ReplyButtonPressClaim> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<SetRow & { callback_query_id: string | null }>(
        `SELECT ${SET_COLUMNS}, callback_query_id
           FROM telegram_reply_button_sets WHERE token = $1 FOR UPDATE`,
        [input.token],
      );
      const row = found.rows[0];
      const sameMessage = row !== undefined && row.telegram_chat_id === input.telegramChatId &&
        (row.telegram_message_id === null || row.telegram_message_id === input.telegramMessageId);
      if (!row || !sameMessage) {
        await client.query("ROLLBACK");
        return { status: "expired" };
      }
      if (row.status === "selected" && row.callback_query_id === input.callbackQueryId) {
        await client.query("COMMIT");
        return { set: toSet(row), status: "replayed" };
      }
      if (row.addressee_telegram_user_id !== input.pressedByTelegramUserId) {
        await client.query("ROLLBACK");
        return { status: "forbidden" };
      }
      const offered = row.status === "active" || (row.status === "staged" && row.message_text !== null);
      if (!offered || input.index >= row.buttons.flat().length) {
        await client.query("ROLLBACK");
        const decided = row.status === "selected" || row.status === "dismissed";
        return decided ? { decided: toSet(row), status: "expired" } : { status: "expired" };
      }
      const claimed = await client.query<SetRow>(
        `UPDATE telegram_reply_button_sets
            SET status = 'selected', selected_index = $2, selected_by_telegram_user_id = $3,
                callback_query_id = $4, resolved_at = now(),
                telegram_message_id = coalesce(telegram_message_id, $5::bigint)
          WHERE id = $1
          RETURNING ${SET_COLUMNS}`,
        [row.id, input.index, input.pressedByTelegramUserId, input.callbackQueryId, input.telegramMessageId],
      );
      await client.query("COMMIT");
      return { set: toSet(claimed.rows[0]!), status: "claimed" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Whether a reply to this route reaches a conversation that will take it as a message: one that
   * exists and does not wait for an approval, which turns away replies.
   */
  async replyRouteIsOpen(baseContinuationToken: string): Promise<boolean> {
    const result = await database().query<{ open: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM conversation_session_routes AS route
           JOIN conversation_sessions AS session ON session.id = route.session_id
          WHERE route.base_continuation_token = $1
            AND session.retired_at IS NULL AND NOT session.pending_operation
       ) AS open`,
      [baseContinuationToken],
    );
    return result.rows[0]?.open === true;
  },

  /** Whether the person has buttons on screen in this chat; a read, so most messages write nothing. */
  async hasActiveForAddressee(input: { addresseeTelegramUserId: string; telegramChatId: string }): Promise<boolean> {
    const result = await database().query<{ offered: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM telegram_reply_button_sets
          WHERE telegram_chat_id = $1 AND addressee_telegram_user_id = $2 AND status = 'active'
       ) AS offered`,
      [input.telegramChatId, input.addresseeTelegramUserId],
    );
    return result.rows[0]?.offered === true;
  },

  /**
   * The addressee wrote instead of tapping: every set they could still tap before that goes away,
   * except one whose tap arrived earlier and is still waiting to be decided.
   */
  async dismissForAddressee(input: {
    addresseeTelegramUserId: string;
    /** The update of the message: a tap with an earlier update came first. */
    afterUpdateId: string;
    telegramChatId: string;
    writtenAt: Date;
  }): Promise<ReplyButtonSet[]> {
    const result = await database().query<SetRow>(
      `UPDATE telegram_reply_button_sets AS offered
          SET status = 'dismissed', resolved_at = now()
        WHERE offered.telegram_chat_id = $1 AND offered.addressee_telegram_user_id = $2
          AND offered.status = 'active' AND offered.activated_at < $3
          AND NOT EXISTS (
            SELECT 1 FROM telegram_ingress_updates AS tap
             WHERE tap.status IN ('pending', 'processing') AND tap.update_id < $4::bigint
               AND tap.payload #>> '{callback_query,data}' LIKE 'rb:' || offered.token || ':%'
               AND tap.payload #>> '{callback_query,from,id}' = offered.addressee_telegram_user_id
          )
        RETURNING ${SET_COLUMNS}`,
      [input.telegramChatId, input.addresseeTelegramUserId, input.writtenAt, input.afterUpdateId],
    );
    return result.rows.map(toSet);
  },
};
