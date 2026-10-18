/**
 * Notices about changes to the family's skills, sent by the application, never written by the model.
 *
 * Exports:
 * - `enqueueFamilySkillNotice`: stores one notice inside the change's own transaction, once per
 *   operation key (a replayed call adds nothing).
 * - `dispatchFamilySkillNotices`: the minute dispatcher's pass: claims pending notices, rechecks that
 *   each recipient is still the family's person or group, sends it, and records the outcome.
 * - `FamilySkillNoticeRecipient`, `FamilySkillNoticeSender`.
 *
 * Notices replace confirmation buttons: a change made by mistake, or by a command hidden in text
 * the agent read, does not go unnoticed. A person gets one in their private chat, a group in the
 * group. A send whose outcome is unknown is recorded as ambiguous and never repeated.
 */
import type { PoolClient } from "pg";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { callTelegramApi } from "../../runtime/telegram/api.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";

export type FamilySkillNoticeRecipient = { readonly userId: string } | { readonly groupId: string };

export type FamilySkillNoticeSender = (input: { readonly chatId: string; readonly text: string }) => Promise<void>;

// A notice is a few lines; Telegram's limit for one message is 4096 characters.
const NOTICE_MAX_CHARACTERS = 3_500;
const CLAIM_BATCH = 20;

export async function enqueueFamilySkillNotice(client: Pick<PoolClient, "query">, input: {
  readonly familyId: string;
  readonly operationKey: string;
  readonly recipient: FamilySkillNoticeRecipient;
  readonly text: string;
}): Promise<void> {
  const text = input.text.length > NOTICE_MAX_CHARACTERS ? `${input.text.slice(0, NOTICE_MAX_CHARACTERS - 1)}…` : input.text;
  await client.query(
    `INSERT INTO family_skill_notices (family_id, operation_key, recipient_user_id, recipient_group_id, text)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (operation_key) DO NOTHING`,
    [
      input.familyId, input.operationKey,
      "userId" in input.recipient ? input.recipient.userId : null,
      "groupId" in input.recipient ? input.recipient.groupId : null,
      text,
    ],
  );
}

async function sendTelegramMessage(input: { readonly chatId: string; readonly text: string }): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new AppError("AGENT_TELEGRAM_CONFIG_MISSING", "Не задан токен Telegram для служебных сообщений о скиллах");
  const response = await callTelegramApi({
    body: { chat_id: input.chatId, text: input.text },
    botToken,
    fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS) }),
    method: "sendMessage",
  });
  if (!response.ok) {
    throw new AppError("AGENT_SKILL_NOTICE_TELEGRAM_REJECTED", "Telegram отклонил служебное сообщение о скилле");
  }
}

interface ClaimedNotice {
  readonly delivery_token: string;
  readonly family_id: string;
  readonly id: string;
  readonly recipient_group_id: string | null;
  readonly recipient_user_id: string | null;
  readonly text: string;
}

/** The chat to send to, if the recipient still belongs to the family. */
async function recipientChat(notice: ClaimedNotice): Promise<string | null> {
  const row = notice.recipient_user_id !== null
    ? (await database().query<{ chat_id: string }>(
      `SELECT users.telegram_user_id AS chat_id FROM users
         JOIN family_memberships membership ON membership.user_id = users.id AND membership.family_id = $2
        WHERE users.id = $1`,
      [notice.recipient_user_id, notice.family_id],
    )).rows[0]
    : (await database().query<{ chat_id: string }>(
      "SELECT telegram_chat_id AS chat_id FROM telegram_groups WHERE id = $1 AND family_id = $2",
      [notice.recipient_group_id, notice.family_id],
    )).rows[0];
  return row?.chat_id ?? null;
}

export async function dispatchFamilySkillNotices(send: FamilySkillNoticeSender = sendTelegramMessage): Promise<number> {
  const client = await database().connect();
  let claimed: ClaimedNotice[];
  try {
    await client.query("BEGIN");
    // A send that never reported back may or may not have reached Telegram: it is not repeated.
    await client.query(
      `UPDATE family_skill_notices SET status = 'ambiguous', delivery_token = NULL, updated_at = now()
        WHERE status = 'delivering' AND delivery_started_at < now() - interval '2 minutes'`,
    );
    claimed = (await client.query<ClaimedNotice>(
      `WITH candidates AS (
         SELECT id FROM family_skill_notices WHERE status = 'pending' ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE family_skill_notices notice
          SET status = 'delivering', delivery_token = gen_random_uuid(), delivery_started_at = now(), updated_at = now()
         FROM candidates WHERE notice.id = candidates.id
       RETURNING notice.id, notice.family_id, notice.recipient_user_id, notice.recipient_group_id, notice.text, notice.delivery_token`,
      [CLAIM_BATCH],
    )).rows;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  for (const [index, notice] of claimed.entries()) {
    let chatId: string | null;
    try {
      chatId = await recipientChat(notice);
      // The stale window counts from this notice's own send, not from the claim of the whole batch.
      await database().query(
        "UPDATE family_skill_notices SET delivery_started_at = now() WHERE id = $1 AND delivery_token = $2",
        [notice.id, notice.delivery_token],
      );
    } catch (error) {
      // Nothing of this notice or the ones after it was sent: they go back to the queue for the next pass.
      for (const unsent of claimed.slice(index)) {
        await database().query(
          `UPDATE family_skill_notices SET status = 'pending', delivery_token = NULL, updated_at = now()
            WHERE id = $1 AND delivery_token = $2 AND status = 'delivering'`,
          [unsent.id, unsent.delivery_token],
        );
      }
      throw error;
    }
    let status: "ambiguous" | "delivered" | "failed" = "failed";
    if (chatId !== null) {
      try {
        await send({ chatId, text: notice.text });
        status = "delivered";
      } catch (error) {
        status = error instanceof AppError && error.code === "AGENT_SKILL_NOTICE_TELEGRAM_REJECTED" ? "failed" : "ambiguous";
        console.error(JSON.stringify({
          code: "AGENT_SKILL_NOTICE_DELIVERY_FAILED", noticeId: notice.id, outcome: status,
          errorName: error instanceof Error ? error.name : "UnknownError",
        }));
      }
    }
    await database().query(
      `UPDATE family_skill_notices SET status = $3, delivery_token = NULL, updated_at = now()
        WHERE id = $1 AND delivery_token = $2 AND status = 'delivering'`,
      [notice.id, notice.delivery_token, status],
    );
  }
  return claimed.length;
}
