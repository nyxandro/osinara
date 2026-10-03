/**
 * Group-scoped durable session integration scenarios.
 *
 * Exports:
 * - `verifyGroupTrustZoneRecreation`: proves route/cursor cleanup and sandbox replacement.
 * - `verifyMonotonicGroupTimelineCursor`: proves current-root cursor monotonicity.
 */
import { expect } from "vitest";

import { database } from "../database.js";
import { groupTimelineCursorRepository } from "./group-timeline-cursor-repository.js";
import { sessionRepository } from "./session-repository.js";

interface SessionOwnerFixture {
  familyId: string;
  userId: string;
}

export async function verifyGroupTrustZoneRecreation(f: SessionOwnerFixture): Promise<void> {
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-100-session-zone', 'Старая зона', 'external', 'addressed_only')
     RETURNING id`,
    [f.familyId],
  );
  const baseToken = "-100-session-zone::77";
  const old = await sessionRepository.prepareTurn({
    baseContinuationToken: baseToken,
    kind: "canonical",
    telegramForumTopicId: null,
    familyId: f.familyId,
    groupId: group.rows[0]!.id,
    now: new Date("2026-07-12T12:00:00.000Z"),
    scope: "group",
    userId: null,
  });
  await sessionRepository.bindAgentSession(old.id, "wrun_old_group_cursor");
  await groupTimelineCursorRepository.advance(old.id, "wrun_old_group_cursor", "10");

  // Keep both lifecycle states attached to the old trust zone with durable cursors.
  await sessionRepository.requestRotation(old.id);
  const active = await sessionRepository.prepareTurn({
    baseContinuationToken: baseToken,
    kind: "canonical",
    telegramForumTopicId: null,
    familyId: f.familyId,
    groupId: group.rows[0]!.id,
    now: new Date("2026-07-12T12:00:30.000Z"),
    scope: "group",
    userId: null,
  });
  await sessionRepository.bindAgentSession(active.id, "wrun_active_group_cursor");
  await groupTimelineCursorRepository.advance(active.id, "wrun_active_group_cursor", "20");
  await sessionRepository.registerRouteAlias(active.id, "-100-session-zone::900");
  const scheduled = await database().query<{ id: string }>(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, group_id, scope, kind, task_state,
        conversation_key, continuation_token, started_at, last_activity_at)
     VALUES (gen_random_uuid(), 0, $1, $2, 'family', 'scheduled', 'running',
             '-100-session-zone::schedule:retire', '-100-session-zone::schedule:retire',
             now(), now())
     RETURNING id`,
    [f.familyId, group.rows[0]!.id],
  );
  const retiredBeforeDeletion = await database().query<{ retired_at: Date }>(
    "SELECT retired_at FROM conversation_sessions WHERE id = $1",
    [old.id],
  );

  await database().query("DELETE FROM telegram_groups WHERE id = $1", [group.rows[0]!.id]);
  const detached = await database().query<{
    generation: number;
    group_id: string | null;
    group_timeline_cursor: string | null;
    retired_at: Date | null;
  }>(
    `SELECT generation, group_id, group_timeline_cursor::text, retired_at
       FROM conversation_sessions
      WHERE id = ANY($1::uuid[])
      ORDER BY generation`,
    [[old.id, active.id]],
  );

  // Deletion retires both generations, removes aliases, and terminally fails scheduled work.
  expect(detached.rows).toEqual([
    {
      generation: 0,
      group_id: null,
      group_timeline_cursor: null,
      retired_at: retiredBeforeDeletion.rows[0]!.retired_at,
    },
    {
      generation: 1,
      group_id: null,
      group_timeline_cursor: null,
      retired_at: expect.any(Date),
    },
  ]);
  await expect(database().query(
    `SELECT 1 FROM conversation_session_routes
      WHERE session_id = ANY($1::uuid[])`,
    [[old.id, active.id]],
  )).resolves.toMatchObject({ rowCount: 0 });
  await expect(database().query(
    `SELECT 1 FROM conversation_sessions
      WHERE id = $1 AND retired_at IS NOT NULL AND task_state = 'failed'`,
    [scheduled.rows[0]!.id],
  )).resolves.toMatchObject({ rowCount: 1 });

  // Re-registering the Telegram chat creates a new trust zone and sandbox generation.
  const replacementGroup = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-100-session-zone', 'Новая зона', 'family_private', 'addressed_only')
     RETURNING id`,
    [f.familyId],
  );
  const replacement = await sessionRepository.prepareTurn({
    baseContinuationToken: baseToken,
    kind: "canonical",
    telegramForumTopicId: null,
    familyId: f.familyId,
    groupId: replacementGroup.rows[0]!.id,
    now: new Date("2026-07-12T12:01:00.000Z"),
    scope: "family",
    userId: null,
  });
  expect(old.generation).toBe(0);
  expect(active.generation).toBe(1);
  expect(replacement).toMatchObject({ generation: 2, rotated: true });
  expect(replacement.sandboxSessionId).not.toBe(active.sandboxSessionId);
  expect(replacement.continuationToken).not.toBe(baseToken);
}

export async function verifyMonotonicGroupTimelineCursor(f: SessionOwnerFixture): Promise<void> {
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-100-session-cursor', 'Курсор', 'family_private', 'addressed_only')
     RETURNING id`,
    [f.familyId],
  );
  const session = await sessionRepository.prepareTurn({
    baseContinuationToken: "-100-session-cursor::10",
    kind: "canonical",
    telegramForumTopicId: null,
    familyId: f.familyId,
    groupId: group.rows[0]!.id,
    now: new Date("2026-07-30T12:00:00.000Z"),
    scope: "family",
    userId: null,
  });
  await sessionRepository.bindAgentSession(session.id, "wrun_cursor");

  // A stale lower sequence cannot move the durable cursor backwards.
  await expect(
    groupTimelineCursorRepository.currentGroupTimelineCursor(session.id),
  ).resolves.toBeNull();
  await groupTimelineCursorRepository.advance(session.id, "wrun_cursor", "10");
  await groupTimelineCursorRepository.advance(session.id, "wrun_cursor", "8");
  await expect(
    groupTimelineCursorRepository.currentGroupTimelineCursor(session.id),
  ).resolves.toBe("10");
}
