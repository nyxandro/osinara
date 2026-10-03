/**
 * Database fixtures for runtime history integration tests.
 *
 * Exports:
 * - `createApplicationSession`: a family, its owner and one personal conversation session bound to
 *   the given runtime session id, as the application creates them before a turn.
 *
 * Test-only: imported by `*.integration.test.ts` files, never by runtime code.
 */
import { randomUUID } from "node:crypto";

import { database } from "../../lib/database.js";

export async function createApplicationSession(sessionId: string, options: { retired?: boolean } = {}) {
  const family = (await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('History test') RETURNING id",
  )).rows[0]!;
  const owner = (await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'Owner') RETURNING id",
    [String(Math.floor(Math.random() * 1e12))],
  )).rows[0]!;
  const key = randomUUID();
  const session = (await database().query<{ id: string }>(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, owner_user_id, scope, kind, conversation_key, continuation_token,
        eve_session_id, started_at, last_activity_at, retired_at, delete_after)
     VALUES (gen_random_uuid(), 0, $1, $2, 'personal', 'canonical', $3, $3, $4, now(), now(),
             CASE WHEN $5 THEN now() END, CASE WHEN $5 THEN now() + interval '30 days' END)
     RETURNING id`,
    [family.id, owner.id, key, sessionId, options.retired === true],
  )).rows[0]!;
  return { applicationSessionId: session.id, familyId: family.id };
}
