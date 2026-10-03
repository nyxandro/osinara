/**
 * Durable at-most-once barrier for Telegram progress notices.
 *
 * Exports:
 * - `TELEGRAM_PROGRESS_NOTICE_MAX_PER_TURN`: flood ceiling for one turn.
 * - `telegramProgressNoticeRepository`: claim before the send, receipt after it.
 *
 * Key construct:
 * - A notice is cosmetic, so a lost one is acceptable and a duplicated one is not: the claim wins
 *   or the send is skipped, and no state transition can turn a skipped notice into a failure.
 */
import { database } from "./database.js";

export const TELEGRAM_PROGRESS_NOTICE_MAX_PER_TURN = 5;

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
       SELECT $1, $2, $3, $4
       WHERE (
         SELECT count(*) FROM telegram_progress_notices
         WHERE agent_session_id = $1 AND agent_turn_id = $2
       ) < $5
       ON CONFLICT (agent_session_id, agent_turn_id, step_index) DO NOTHING
       RETURNING id`,
      [
        input.agentSessionId,
        input.agentTurnId,
        input.stepIndex,
        input.applicationSessionId,
        TELEGRAM_PROGRESS_NOTICE_MAX_PER_TURN,
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
