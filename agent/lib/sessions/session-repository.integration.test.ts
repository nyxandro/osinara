/**
 * Durable session lifecycle PostgreSQL tests.
 *
 * Constructs covered:
 * - Generation-zero session creation and route re-keying.
 * - Monotonic Eve root rebinding after a terminal workflow replacement.
 * - Rotation after thresholds while pending operations remain pinned.
 * - Stable sandbox identity across generations and replacement at a trust-zone boundary.
 * - Retention leasing for retired Eve sessions.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "./session-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

async function fixture() {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Сессии') RETURNING id",
  );
  const user = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ('session-owner', 'Владелец') RETURNING id`,
  );
  await database().query(
    `INSERT INTO family_memberships (family_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [family.rows[0]!.id, user.rows[0]!.id],
  );
  return { familyId: family.rows[0]!.id, userId: user.rows[0]!.id };
}

describeWithDatabase("session repository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE conversation_session_routes, conversation_sessions, family_memberships, users, families CASCADE",
    );
  });
  afterAll(async () => closeDatabase());

  it("continues generation zero and follows Telegram anchor re-keying", async () => {
    const f = await fixture();
    const current = await sessionRepository.prepareTurn({
      baseContinuationToken: "101::",
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-07-12T12:00:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });

    expect(current).toMatchObject({ continuationToken: "101::", generation: 0, rotated: false });
    await sessionRepository.bindEveSession(current.id, "wrun_generation_zero");
    await sessionRepository.registerRoute(current.id, "101:42:900");
    await expect(database().query<{ continuation_token: string }>(
      `SELECT s.continuation_token
         FROM conversation_session_routes r
         JOIN conversation_sessions s ON s.id = r.session_id
        WHERE r.base_continuation_token = $1`,
      ["101:42:900"],
    )).resolves.toMatchObject({ rows: [{ continuation_token: "101:42:900" }] });
  });

  it("defers a requested rotation until the pending operation completes", async () => {
    const f = await fixture();
    const current = await sessionRepository.prepareTurn({
      baseContinuationToken: "102::",
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-07-12T12:00:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });
    await sessionRepository.markPendingOperation(current.id, true);
    await sessionRepository.requestRotation(current.id);

    const pinned = await sessionRepository.prepareTurn({
      baseContinuationToken: "102::",
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-08-20T12:00:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });
    expect(pinned.id).toBe(current.id);

    await sessionRepository.recordTurnCompleted(current.id, "wrun_old", false);
    const rotated = await sessionRepository.prepareTurn({
      baseContinuationToken: "102::",
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-08-20T12:01:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });
    expect(rotated).toMatchObject({ continuationToken: "102:::osinara:1", generation: 1, rotated: true });
    expect(rotated.sandboxSessionId).toBe(current.sandboxSessionId);
    await expect(sessionRepository.isCurrentEveSession(current.id, "wrun_old")).resolves.toBe(false);
    await sessionRepository.bindEveSession(rotated.id, "wrun_new");
    await expect(sessionRepository.isCurrentEveSession(rotated.id, "wrun_new")).resolves.toBe(true);
  });

  it("accepts a newer Eve root and ignores delayed events from the replaced root", async () => {
    const f = await fixture();
    const current = await sessionRepository.prepareTurn({
      baseContinuationToken: "104::",
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-07-12T12:00:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });
    const oldRoot = "wrun_01KXB392VJ8YY13JMJ9YZAF5QR";
    const newRoot = "wrun_01KXBRD0AY4NP50QXR7C5D6YEK";

    await expect(sessionRepository.bindEveSession(current.id, oldRoot)).resolves.toBe("recorded");
    await expect(sessionRepository.bindEveSession(current.id, newRoot)).resolves.toBe("recorded");
    await sessionRepository.markPendingOperation(current.id, true);
    await expect(sessionRepository.recordTurnCompleted(current.id, oldRoot, false)).resolves.toBe("stale");
    await expect(sessionRepository.recordTurnFailed(current.id, oldRoot)).resolves.toBe("stale");
    await expect(sessionRepository.recordSessionFailedByContinuationToken(
      current.continuationToken,
      oldRoot,
    )).resolves.toBe("stale");

    const stored = await database().query<{
      completed_turns: number;
      eve_session_id: string;
      pending_operation: boolean;
      rotation_requested_at: Date | null;
    }>(
      `SELECT completed_turns, eve_session_id, pending_operation, rotation_requested_at
         FROM conversation_sessions WHERE id = $1`,
      [current.id],
    );
    expect(stored.rows[0]).toEqual({
      completed_turns: 0,
      eve_session_id: newRoot,
      pending_operation: true,
      rotation_requested_at: null,
    });
  });

  it("records a terminal failure from a newer root before turn.started binds it", async () => {
    const f = await fixture();
    const current = await sessionRepository.prepareTurn({
      baseContinuationToken: "105::",
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-07-12T12:00:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });
    const previousRoot = "wrun_01KXB392VJ8YY13JMJ9YZAF5QR";
    const failedRoot = "wrun_01KXBRD0AY4NP50QXR7C5D6YEK";
    await sessionRepository.bindEveSession(current.id, previousRoot);
    await sessionRepository.markPendingOperation(current.id, true);

    await expect(sessionRepository.recordSessionFailedByContinuationToken(
      current.continuationToken,
      failedRoot,
    )).resolves.toBe("recorded");

    await expect(database().query(
      `SELECT 1 FROM conversation_sessions
        WHERE id = $1
          AND eve_session_id = $2
          AND pending_operation = false
          AND rotation_requested_at IS NOT NULL`,
      [current.id, failedRoot],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("leases only retired sessions whose 90-day retention has elapsed", async () => {
    const f = await fixture();
    const current = await sessionRepository.prepareTurn({
      baseContinuationToken: "103::",
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-01-01T00:00:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });
    await sessionRepository.bindEveSession(current.id, "wrun_expired");
    await sessionRepository.requestRotation(current.id);
    await sessionRepository.prepareTurn({
      baseContinuationToken: "103::",
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-01-02T00:00:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });
    await database().query(
      "UPDATE conversation_sessions SET delete_after = '2026-04-02T00:00:00.000Z' WHERE id = $1",
      [current.id],
    );

    const claim = await sessionRepository.claimExpiredForDeletion(
      new Date("2026-04-02T00:00:01.000Z"),
    );
    expect(claim).toMatchObject({ eveSessionId: "wrun_expired", id: current.id });
    await sessionRepository.completeDeletion(claim!.id, claim!.leaseToken);
    await expect(database().query(
      "SELECT id FROM conversation_sessions WHERE id = $1",
      [current.id],
    )).resolves.toMatchObject({ rowCount: 0 });
  });

  it("starts a new generation when a Telegram group trust zone is recreated", async () => {
    const f = await fixture();
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100-session-zone', 'Старая зона', 'external_private', 'addressed_only')
       RETURNING id`,
      [f.familyId],
    );
    const baseToken = "-100-session-zone::77";
    const old = await sessionRepository.prepareTurn({
      baseContinuationToken: baseToken,
      familyId: f.familyId,
      groupId: group.rows[0]!.id,
      now: new Date("2026-07-12T12:00:00.000Z"),
      scope: "group",
      userId: null,
    });
    await database().query("DELETE FROM telegram_groups WHERE id = $1", [group.rows[0]!.id]);
    const replacementGroup = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100-session-zone', 'Новая зона', 'family_private', 'addressed_only')
       RETURNING id`,
      [f.familyId],
    );

    const replacement = await sessionRepository.prepareTurn({
      baseContinuationToken: baseToken,
      familyId: f.familyId,
      groupId: replacementGroup.rows[0]!.id,
      now: new Date("2026-07-12T12:01:00.000Z"),
      scope: "family",
      userId: null,
    });
    expect(old.generation).toBe(0);
    expect(replacement).toMatchObject({ generation: 1, rotated: true });
    expect(replacement.sandboxSessionId).not.toBe(old.sandboxSessionId);
    expect(replacement.continuationToken).not.toBe(baseToken);
  });
});
