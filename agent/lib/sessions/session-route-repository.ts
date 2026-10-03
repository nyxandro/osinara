/**
 * Durable Telegram routes for application-owned sessions.
 *
 * Exports:
 * - `upsertSessionRoute`: transaction-scoped route update used during turn preparation.
 * - `sessionRouteRepository`: resumable lookup and stable out-of-band alias registration.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";

export async function upsertSessionRoute(
  client: PoolClient,
  baseToken: string,
  sessionId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO conversation_session_routes (base_continuation_token, session_id)
     VALUES ($1, $2)
     ON CONFLICT (base_continuation_token) DO UPDATE
       SET session_id = EXCLUDED.session_id, updated_at = now()`,
    [baseToken, sessionId],
  );
}

export const sessionRouteRepository = {
  async hasRoute(baseContinuationToken: string): Promise<boolean> {
    const result = await database().query(
      `SELECT 1
         FROM conversation_session_routes route
         JOIN conversation_sessions session ON session.id = route.session_id
        WHERE route.base_continuation_token = $1
           AND session.retired_at IS NULL
           AND session.agent_session_id IS NOT NULL
           AND (session.kind <> 'task' OR session.task_state = 'pending')
        LIMIT 1`,
      [baseContinuationToken],
    );
    return Boolean(result.rowCount);
  },

  async registerRouteAlias(id: string, baseToken: string): Promise<void> {
    // Only personal conversations and non-canonical tasks need Telegram message aliases. Ordinary
    // group responses are ancestry in the shared timeline and must never become task selectors.
    const result = await database().query(
      `INSERT INTO conversation_session_routes (base_continuation_token, session_id)
       SELECT $2, id FROM conversation_sessions
        WHERE id = $1 AND retired_at IS NULL
          AND (group_id IS NULL OR kind <> 'canonical')
       ON CONFLICT (base_continuation_token) DO UPDATE
         SET updated_at = now()
       WHERE conversation_session_routes.session_id = EXCLUDED.session_id`,
      [id, baseToken],
    );
    if (result.rowCount === 1) return;

    const canonicalGroup = await database().query(
      `SELECT 1 FROM conversation_sessions
        WHERE id = $1 AND retired_at IS NULL AND group_id IS NOT NULL AND kind = 'canonical'`,
      [id],
    );
    if (canonicalGroup.rowCount === 1) return;

    // Distinguish a stale session from an alias collision for actionable diagnostics.
    const active = await database().query(
      "SELECT 1 FROM conversation_sessions WHERE id = $1 AND retired_at IS NULL",
      [id],
    );
    if (active.rowCount === 1) {
      throw new AppError(
        "AGENT_SESSION_ROUTE_CONFLICT",
        "Сообщение Telegram уже связано с другим активным контекстом",
      );
    }
    throw new AppError("AGENT_SESSION_NOT_ACTIVE", "Текущий контекст уже завершён");
  },
};
