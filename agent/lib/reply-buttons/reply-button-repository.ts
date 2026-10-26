/**
 * PostgreSQL state of reply-button sets.
 *
 * Exports:
 * - `ReplyButtonSet`: one stored set as the delivery, press and dismissal paths read it.
 * - `ReplyButtonPressClaim`: the outcome of claiming one press.
 * - `replyButtonRepository`: staging by a turn or a reminder, delivery bookkeeping, the press
 *   claim and the dismissal by the addressee's own message.
 *
 * Key constructs:
 * - A press is claimed in one statement: only the addressee, only a set still offering its buttons,
 *   only once. The same callback query repeated after a crash finds its own claim again.
 * - A set whose message went out before its number was saved (a crash in between) still accepts
 *   its press: the token is unguessable and the chat must match, so the message comes from the press.
 * - Dismissal touches only sets that were visible before the addressee's message was written:
 *   buttons the agent offered after it, in answer to it, stay.
 */
import type { JsonObject } from "../../runtime/json.js";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { ReplyButtonRows } from "./reply-button-contract.js";

export type ReplyButtonMessageFormat = "plain" | "rich";

export interface ReplyButtonSet {
  addresseeTelegramUserId: string;
  buttons: ReplyButtonRows;
  id: string;
  /** Formatting entities of a plain message, kept so the settled caption does not strip them. */
  messageEntities: readonly JsonObject[] | null;
  messageFormat: ReplyButtonMessageFormat | null;
  messageText: string | null;
  resolvedAt: Date | null;
  selectedIndex: number | null;
  telegramChatId: string;
  telegramChatType: "group" | "private" | "supergroup";
  telegramMessageId: string | null;
  token: string;
}

export type ReplyButtonPressClaim =
  | { set: ReplyButtonSet; status: "claimed" | "replayed" }
  | { status: "expired" | "forbidden" };

interface SetRow {
  addressee_telegram_user_id: string;
  buttons: ReplyButtonRows;
  id: string;
  message_entities: readonly JsonObject[] | null;
  message_format: ReplyButtonMessageFormat | null;
  message_text: string | null;
  resolved_at: Date | null;
  selected_index: number | null;
  telegram_chat_id: string;
  telegram_chat_type: "group" | "private" | "supergroup";
  telegram_message_id: string | null;
  token: string;
}

const SET_COLUMNS = `id, token, telegram_chat_id, telegram_chat_type, addressee_telegram_user_id, buttons,
  telegram_message_id::text, message_text, message_format, message_entities, selected_index, resolved_at`;

function toSet(row: SetRow): ReplyButtonSet {
  return {
    addresseeTelegramUserId: row.addressee_telegram_user_id,
    buttons: row.buttons,
    id: row.id,
    messageEntities: row.message_entities,
    messageFormat: row.message_format,
    messageText: row.message_text,
    resolvedAt: row.resolved_at,
    selectedIndex: row.selected_index,
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
  /** The buttons of one turn; a second call of the tool in the same turn replaces them. */
  async stageForTurn(input: ReplyButtonTarget & {
    agentSessionId: string;
    agentTurnId: string;
    buttons: ReplyButtonRows;
    token: string;
  }): Promise<void> {
    await database().query(
      `INSERT INTO telegram_reply_button_sets
         (token, origin, agent_session_id, agent_turn_id, telegram_chat_id, telegram_chat_type,
          addressee_telegram_user_id, buttons, status)
       VALUES ($1, 'turn', $2, $3, $4, $5, $6, $7::jsonb, 'staged')
       ON CONFLICT (agent_turn_id) WHERE status = 'staged'
       DO UPDATE SET token = EXCLUDED.token, buttons = EXCLUDED.buttons,
                     telegram_chat_id = EXCLUDED.telegram_chat_id,
                     telegram_chat_type = EXCLUDED.telegram_chat_type,
                     addressee_telegram_user_id = EXCLUDED.addressee_telegram_user_id`,
      [input.token, input.agentSessionId, input.agentTurnId, input.telegramChatId, input.telegramChatType,
        input.addresseeTelegramUserId, JSON.stringify(input.buttons)],
    );
  },

  async findStagedForTurn(agentTurnId: string): Promise<ReplyButtonSet | null> {
    const result = await database().query<SetRow>(
      `SELECT ${SET_COLUMNS} FROM telegram_reply_button_sets WHERE agent_turn_id = $1 AND status = 'staged'`,
      [agentTurnId],
    );
    return result.rows[0] ? toSet(result.rows[0]) : null;
  },

  /** A reminder's buttons for one delivery: its text is known before the message is sent. */
  async stageForReminder(input: ReplyButtonTarget & {
    buttons: ReplyButtonRows;
    messageEntities: readonly JsonObject[];
    messageText: string;
    reminderId: string;
    token: string;
  }): Promise<ReplyButtonSet> {
    const result = await database().query<SetRow>(
      `INSERT INTO telegram_reply_button_sets
         (token, origin, reminder_id, telegram_chat_id, telegram_chat_type, addressee_telegram_user_id,
          buttons, status, message_text, message_format, message_entities)
       VALUES ($1, 'reminder', $2, $3, $4, $5, $6::jsonb, 'staged', $7, 'plain', $8::jsonb)
       RETURNING ${SET_COLUMNS}`,
      [input.token, input.reminderId, input.telegramChatId, input.telegramChatType, input.addresseeTelegramUserId,
        JSON.stringify(input.buttons), input.messageText, JSON.stringify(input.messageEntities)],
    );
    return toSet(result.rows[0]!);
  },

  /** The exact text the buttons go out under, written before that message is sent. */
  async recordMessageText(id: string, messageText: string, messageFormat: ReplyButtonMessageFormat): Promise<void> {
    const result = await database().query(
      `UPDATE telegram_reply_button_sets SET message_text = $2, message_format = $3
        WHERE id = $1 AND status = 'staged'`,
      [id, messageText, messageFormat],
    );
    if (result.rowCount !== 1) {
      throw new AppError("AGENT_REPLY_BUTTONS_STATE_INVALID", "Кнопки ответа уже не ждут отправки");
    }
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
      const found = await client.query<SetRow & { callback_query_id: string | null; status: string }>(
        `SELECT ${SET_COLUMNS}, status, callback_query_id
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
        return { status: "expired" };
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

  /** The addressee wrote instead of tapping: every set they could still tap before that goes away. */
  async dismissForAddressee(input: {
    addresseeTelegramUserId: string;
    telegramChatId: string;
    writtenAt: Date;
  }): Promise<ReplyButtonSet[]> {
    const result = await database().query<SetRow>(
      `UPDATE telegram_reply_button_sets
          SET status = 'dismissed', resolved_at = now()
        WHERE telegram_chat_id = $1 AND addressee_telegram_user_id = $2
          AND status = 'active' AND activated_at < $3
        RETURNING ${SET_COLUMNS}`,
      [input.telegramChatId, input.addresseeTelegramUserId, input.writtenAt],
    );
    return result.rows.map(toSet);
  },
};
