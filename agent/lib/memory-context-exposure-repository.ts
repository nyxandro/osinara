/**
 * Exposure ledger for automatic memory context.
 *
 * Export:
 * - `memoryContextExposureRepository`: which memory refs and which author cards this application
 *   session has already shown, keyed by the session's completed-turn counter; also the exact set
 *   shown in one turn, which bounds what a `<memory-used>` directive may reinforce.
 *
 * Key construct:
 * - The window is measured in turns of the same application session, not in time: a quiet chat
 *   keeps a fact suppressed for exactly as many replies as a busy one.
 */
import { database } from "./database.js";
import { MEMORY_EXPOSURE_WINDOW_TURNS, PROFILE_AUTHOR_CARD_WINDOW_TURNS } from "./memory-config.js";

export const memoryContextExposureRepository = {
  /** Completed turns of the application session; the exposure ordinal of the turn being built. */
  async sessionTurn(applicationSessionId: string): Promise<number> {
    const result = await database().query<{ completed_turns: number }>(
      "SELECT completed_turns FROM conversation_sessions WHERE id = $1",
      [applicationSessionId],
    );
    return result.rows[0]?.completed_turns ?? 0;
  },

  async recentlyShownMemoryRefs(applicationSessionId: string, sessionTurn: number): Promise<Set<string>> {
    const result = await database().query<{ memory_ref: string }>(
      `SELECT memory_ref FROM memory_context_exposures
        WHERE application_session_id = $1 AND session_turn > $2`,
      [applicationSessionId, sessionTurn - MEMORY_EXPOSURE_WINDOW_TURNS],
    );
    return new Set(result.rows.map((row) => row.memory_ref));
  },

  /** Refs shown to the model in exactly this turn (automatic block or explicit search). */
  async shownMemoryRefsForTurn(applicationSessionId: string, sessionTurn: number): Promise<Set<string>> {
    const result = await database().query<{ memory_ref: string }>(
      `SELECT memory_ref FROM memory_context_exposures
        WHERE application_session_id = $1 AND session_turn = $2`,
      [applicationSessionId, sessionTurn],
    );
    return new Set(result.rows.map((row) => row.memory_ref));
  },

  async authorCardShownRecently(applicationSessionId: string, telegramUserId: string, sessionTurn: number): Promise<boolean> {
    const result = await database().query(
      `SELECT 1 FROM profile_author_exposures
        WHERE application_session_id = $1 AND telegram_user_id = $2 AND session_turn > $3`,
      [applicationSessionId, telegramUserId, sessionTurn - PROFILE_AUTHOR_CARD_WINDOW_TURNS],
    );
    return (result.rowCount ?? 0) > 0;
  },

  async record(input: {
    applicationSessionId: string;
    authorTelegramUserId: string | null;
    memoryRefs: readonly string[];
    sessionTurn: number;
  }): Promise<void> {
    if (input.memoryRefs.length > 0) {
      await database().query(
        `INSERT INTO memory_context_exposures (application_session_id, memory_ref, session_turn)
         SELECT $1, ref, $2 FROM unnest($3::text[]) AS ref
         ON CONFLICT (application_session_id, memory_ref) DO UPDATE
           SET session_turn = EXCLUDED.session_turn, shows = memory_context_exposures.shows + 1,
               last_shown_at = now()`,
        [input.applicationSessionId, input.sessionTurn, [...new Set(input.memoryRefs)]],
      );
    }
    if (input.authorTelegramUserId !== null) {
      await database().query(
        `INSERT INTO profile_author_exposures (application_session_id, telegram_user_id, session_turn)
         VALUES ($1, $2, $3)
         ON CONFLICT (application_session_id, telegram_user_id) DO UPDATE
           SET session_turn = EXCLUDED.session_turn, last_shown_at = now()`,
        [input.applicationSessionId, input.authorTelegramUserId, input.sessionTurn],
      );
    }
  },
};
