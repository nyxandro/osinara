/**
 * Durable session lifecycle PostgreSQL tests.
 *
 * Constructs covered:
 * - Generation-zero session creation and stable route aliases.
 * - Monotonic Eve root rebinding after a terminal workflow replacement.
 * - Terminal failure resolution through any durable Telegram route after re-keying.
 * - Rotation after thresholds while pending operations remain pinned.
 * - Stable sandbox identity across generations and replacement at a trust-zone boundary.
 * - Retention leasing for retired Eve sessions.
 * - Monotonic per-session Telegram group timeline cursors.
 * - Group trust-zone scenarios are implemented in the colocated scenario module.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "./session-repository.js";
import {
  verifyGroupTrustZoneRecreation,
  verifyMonotonicGroupTimelineCursor,
} from "./session-repository.group-integration-scenarios.js";

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
      "TRUNCATE conversation_session_routes, conversation_sessions, conversation_route_generations, family_memberships, users, families CASCADE",
    );
  });
  afterAll(async () => closeDatabase());

  it("continues generation zero while delivered Telegram anchors remain aliases", async () => {
    const f = await fixture();
    const current = await sessionRepository.prepareTurn({
      baseContinuationToken: "101::",
      kind: "canonical",
      telegramForumTopicId: null,
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-07-12T12:00:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });

    expect(current).toMatchObject({ continuationToken: "101::", generation: 0, rotated: false });
    await sessionRepository.bindEveSession(current.id, "wrun_generation_zero");
    await sessionRepository.registerRouteAlias(current.id, "101:42:900");
    await expect(database().query<{ continuation_token: string }>(
      `SELECT s.continuation_token
         FROM conversation_session_routes r
         JOIN conversation_sessions s ON s.id = r.session_id
        WHERE r.base_continuation_token = $1`,
      ["101:42:900"],
    )).resolves.toMatchObject({ rows: [{ continuation_token: "101::" }] });
    await expect(sessionRepository.hasRoute("101:42:900")).resolves.toBe(true);
    await expect(sessionRepository.hasRoute("101:42:901")).resolves.toBe(false);
  });

  it("does not treat an unbound route from a failed first turn as resumable", async () => {
    const f = await fixture();
    const current = await sessionRepository.prepareTurn({
      baseContinuationToken: "101:42:900",
      kind: "canonical",
      telegramForumTopicId: null,
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-07-12T12:00:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });

    await expect(sessionRepository.hasRoute("101:42:900")).resolves.toBe(false);
    await sessionRepository.bindEveSession(current.id, "wrun_bound_after_start");
    await expect(sessionRepository.hasRoute("101:42:900")).resolves.toBe(true);
  });

  it("resumes the current Eve continuation through a tool-delivery route alias", async () => {
    const f = await fixture();
    const current = await sessionRepository.prepareTurn({
      baseContinuationToken: "101::400",
      kind: "canonical",
      telegramForumTopicId: null,
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-07-12T12:00:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });
    await sessionRepository.bindEveSession(current.id, "wrun_tool_route");
    await sessionRepository.registerRouteAlias(current.id, "101::401");

    const resumed = await sessionRepository.prepareTurn({
      baseContinuationToken: "101::401",
      kind: "canonical",
      telegramForumTopicId: null,
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-07-12T12:01:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });

    expect(resumed.id).toBe(current.id);
    expect(resumed.continuationToken).toBe("101::400");
  });

  it("defers a requested rotation until the pending operation completes", async () => {
    const f = await fixture();
    const current = await sessionRepository.prepareTurn({
      baseContinuationToken: "102::",
      kind: "canonical",
      telegramForumTopicId: null,
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
      kind: "canonical",
      telegramForumTopicId: null,
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
      kind: "canonical",
      telegramForumTopicId: null,
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

  it("moves every delivered Telegram alias to the new generation during rotation", async () => {
    const f = await fixture();
    const current = await sessionRepository.prepareTurn({
      baseContinuationToken: "103::",
      kind: "canonical",
      telegramForumTopicId: null,
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-07-12T12:00:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });
    await sessionRepository.bindEveSession(current.id, "wrun_before_alias_rotation");
    await sessionRepository.registerRouteAlias(current.id, "103::900");
    await sessionRepository.registerRouteAlias(current.id, "103::901");
    await sessionRepository.requestRotation(current.id);

    const rotated = await sessionRepository.prepareTurn({
      baseContinuationToken: "103::900",
      kind: "canonical",
      telegramForumTopicId: null,
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-07-12T12:01:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });
    const resumedThroughOtherAlias = await sessionRepository.prepareTurn({
      baseContinuationToken: "103::901",
      kind: "canonical",
      telegramForumTopicId: null,
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-07-12T12:02:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });

    expect(rotated).toMatchObject({ generation: 1, rotated: true });
    expect(resumedThroughOtherAlias).toMatchObject({
      continuationToken: rotated.continuationToken,
      generation: 1,
      id: rotated.id,
      rotated: false,
    });
  });

  it("accepts a newer Eve root and ignores delayed events from the replaced root", async () => {
    const f = await fixture();
    const current = await sessionRepository.prepareTurn({
      baseContinuationToken: "104::",
      kind: "canonical",
      telegramForumTopicId: null,
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
      kind: "canonical",
      telegramForumTopicId: null,
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

  it("records a terminal failure through an earlier route after Telegram re-keying", async () => {
    const f = await fixture();
    const current = await sessionRepository.prepareTurn({
      baseContinuationToken: "106::426",
      kind: "canonical",
      telegramForumTopicId: null,
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-07-12T12:00:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });
    const failedRoot = "wrun_01KXBRD0AY4NP50QXR7C5D6YEK";
    await sessionRepository.bindEveSession(current.id, failedRoot);
    await sessionRepository.registerRouteAlias(current.id, "106::437");

    await expect(sessionRepository.recordSessionFailedByContinuationToken(
      "106::426",
      failedRoot,
    )).resolves.toBe("recorded");

    await expect(database().query(
      `SELECT 1 FROM conversation_sessions
        WHERE id = $1
          AND pending_operation = false
          AND rotation_requested_at IS NOT NULL`,
      [current.id],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("leases only retired sessions whose one-day retention has elapsed", async () => {
    const f = await fixture();
    const current = await sessionRepository.prepareTurn({
      baseContinuationToken: "103::",
      kind: "canonical",
      telegramForumTopicId: null,
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
      kind: "canonical",
      telegramForumTopicId: null,
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-01-02T00:00:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });
    await expect(database().query(
      `SELECT retired_at, delete_after FROM conversation_sessions WHERE id = $1
         AND delete_after = retired_at + interval '1 day'`,
      [current.id],
    )).resolves.toMatchObject({ rowCount: 1 });

    await expect(sessionRepository.claimExpiredForDeletion(
      new Date("2026-01-02T23:59:59.000Z"),
    )).resolves.toBeNull();

    const claim = await sessionRepository.claimExpiredForDeletion(
      new Date("2026-01-03T00:00:01.000Z"),
    );
    expect(claim).toMatchObject({ eveSessionId: "wrun_expired", id: current.id });
    await sessionRepository.completeDeletion(claim!.id, claim!.leaseToken);
    await expect(database().query(
      "SELECT id FROM conversation_sessions WHERE id = $1",
      [current.id],
    )).resolves.toMatchObject({ rowCount: 0 });
  });

  it("tries a failed cleanup again later instead of parking the session for good", async () => {
    const f = await fixture();
    const current = await sessionRepository.prepareTurn({
      baseContinuationToken: "104::",
      kind: "canonical",
      telegramForumTopicId: null,
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-01-01T00:00:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });
    await sessionRepository.bindEveSession(current.id, "wrun_retry");
    await sessionRepository.requestRotation(current.id);
    await sessionRepository.prepareTurn({
      baseContinuationToken: "104::",
      kind: "canonical",
      telegramForumTopicId: null,
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-01-02T00:00:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });

    const first = await sessionRepository.claimExpiredForDeletion(
      new Date("2026-01-03T00:00:01.000Z"),
    );
    expect(first).toMatchObject({ eveSessionId: "wrun_retry", id: current.id });
    await sessionRepository.failDeletion(
      first!.id, first!.leaseToken, "AGENT_EVE_SESSION_STORAGE_ACTIVE",
      new Date("2026-01-03T00:00:02.000Z"),
    );

    // The usual reason a cleanup fails is a run that had not finished yet, so the session waits
    // out the backoff and is offered again rather than staying behind for good.
    await expect(sessionRepository.claimExpiredForDeletion(
      new Date("2026-01-03T00:30:00.000Z"),
    )).resolves.toBeNull();

    const retry = await sessionRepository.claimExpiredForDeletion(
      new Date("2026-01-03T02:00:00.000Z"),
    );
    expect(retry).toMatchObject({ eveSessionId: "wrun_retry", id: current.id });
  });

  it("clears active and retired group cursors when a Telegram trust zone is recreated", async () => {
    await verifyGroupTrustZoneRecreation(await fixture());
  });

  it("advances a group timeline cursor monotonically for the current Eve root", async () => {
    await verifyMonotonicGroupTimelineCursor(await fixture());
  });
});
