/**
 * Durable at-most-once barrier for Telegram progress notices.
 *
 * Export:
 * - `telegramProgressNoticeRepository`: claim before the send, receipt after it.
 *
 * Key construct:
 * - A notice is cosmetic, so a lost one is acceptable and a duplicated one is not: the claim wins
 *   or the send is skipped, and no state transition can turn a skipped notice into a failure.
 * - A turn has no ceiling on notices: the private chat shows a note while it is written, and one
 *   that then never became a message vanished before the person's eyes (#483). How many notes a
 *   turn writes is the prompt's matter.
 */
import { database } from "./database.js";

export const telegramProgressNoticeRepository = {
  async claim(input: {
    applicationSessionId: string;
    agentSessionId: string;
    agentTurnId: string;
    stepIndex: number;
  }): Promise<{ noticeId: string } | null> {
    const claimed = await database().query<{ id: string }>(
      `INSERT INTO telegram_progress_notices
         (agent_session_id, agent_turn_id, step_index, application_session_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (agent_session_id, agent_turn_id, step_index) DO NOTHING
       RETURNING id`,
      [
        input.agentSessionId,
        input.agentTurnId,
        input.stepIndex,
        input.applicationSessionId,
      ],
    );
    const noticeId = claimed.rows[0]?.id;
    return noticeId === undefined ? null : { noticeId };
  },

  async confirm(noticeId: string, telegramMessageId: string): Promise<void> {
    await database().query(
      `UPDATE telegram_progress_notices
       SET telegram_message_id = $2, sent_at = now()
       WHERE id = $1 AND sent_at IS NULL`,
      [noticeId, telegramMessageId],
    );
  },
};
