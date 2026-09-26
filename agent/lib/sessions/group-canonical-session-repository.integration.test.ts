/**
 * Canonical group/task session lifecycle PostgreSQL tests.
 *
 * Constructs covered:
 * - Concurrent canonical preparation and verified topic isolation.
 * - Atomic canonical-to-task promotion and lazy canonical replacement.
 * - Exact task continuation without allowing ordinary aliases to select the task.
 * - Prompt task completion/failure retirement and retention eligibility.
 * - Park identity preservation when a later boundary has no request metadata.
 * - Atomic terminal lifecycle mutation, route cleanup, and audit persistence.
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
    "INSERT INTO families (name) VALUES ('Canonical sessions') RETURNING id",
  );
  const user = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('canonical-owner', 'Owner') RETURNING id",
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, user.rows[0]!.id],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-100-canonical', 'Canonical', 'family_private', 'addressed_only')
     RETURNING id`,
    [family.rows[0]!.id],
  );
  return {
    familyId: family.rows[0]!.id,
    groupId: group.rows[0]!.id,
    userId: user.rows[0]!.id,
  };
}

function canonicalInput(
  fixtureData: Awaited<ReturnType<typeof fixture>>,
  topicId: number | null,
) {
  return {
    baseContinuationToken: topicId === null
      ? `osinara:group:${fixtureData.groupId}:main`
      : `osinara:group:${fixtureData.groupId}:topic:${topicId}`,
    familyId: fixtureData.familyId,
    groupId: fixtureData.groupId,
    kind: "canonical" as const,
    now: new Date("2026-08-03T12:00:00.000Z"),
    scope: "family" as const,
    telegramForumTopicId: topicId,
    userId: null,
  };
}

describeWithDatabase("canonical group session repository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE telegram_hitl_approvals, conversation_session_routes, conversation_sessions, conversation_route_generations, telegram_groups, family_memberships, users, families CASCADE",
    );
  });
  afterAll(closeDatabase);

  it("returns one canonical row under concurrent preparation and isolates topics", async () => {
    const f = await fixture();
    const [first, second] = await Promise.all([
      sessionRepository.prepareTurn(canonicalInput(f, null)),
      sessionRepository.prepareTurn(canonicalInput(f, null)),
    ]);
    const topic = await sessionRepository.prepareTurn(canonicalInput(f, 77));

    expect(second.id).toBe(first.id);
    expect(topic.id).not.toBe(first.id);
    await expect(database().query(
      `SELECT 1 FROM conversation_sessions
        WHERE group_id = $1 AND kind = 'canonical' AND retired_at IS NULL`,
      [f.groupId],
    )).resolves.toMatchObject({ rowCount: 2 });
  });

  it("promotes a parked canonical and lets an unrelated turn create its replacement", async () => {
    const f = await fixture();
    const canonical = await sessionRepository.prepareTurn(canonicalInput(f, null));
    await sessionRepository.bindEveSession(canonical.id, "wrun_task");
    await sessionRepository.registerRouteAlias(canonical.id, "-100-canonical::500");

    await sessionRepository.parkSession({
      applicationSessionId: canonical.id,
      pendingRequestId: "request-1",
      requesterTelegramUserId: "canonical-owner",
      requesterUserId: f.userId,
    });
    await sessionRepository.registerRouteAlias(canonical.id, "-100-canonical::501");
    const replacement = await sessionRepository.prepareTurn(canonicalInput(f, null));

    expect(replacement.id).not.toBe(canonical.id);
    expect(replacement.sandboxSessionId).toBe(canonical.sandboxSessionId);
    await expect(sessionRepository.hasRoute("-100-canonical::500")).resolves.toBe(false);
    await expect(sessionRepository.hasRoute("-100-canonical::501")).resolves.toBe(true);

    const resumed = await sessionRepository.prepareTurn({
      ...canonicalInput(f, null),
      baseContinuationToken: "-100-canonical::501",
      kind: "task",
    });
    expect(resumed.id).toBe(canonical.id);
  });

  it("allocates above newer retired generations when an older running task remains", async () => {
    const f = await fixture();
    const staleTask = await sessionRepository.prepareTurn(canonicalInput(f, null));
    await sessionRepository.bindEveSession(staleTask.id, "wrun_stale_task");
    await sessionRepository.parkSession({
      applicationSessionId: staleTask.id,
      pendingRequestId: "request-stale",
      requesterTelegramUserId: "canonical-owner",
      requesterUserId: f.userId,
    });
    await sessionRepository.resumePendingSession(staleTask.id, "wrun_stale_task");

    const firstReplacement = await sessionRepository.prepareTurn(canonicalInput(f, null));
    await sessionRepository.requestRotation(firstReplacement.id);
    const newer = await sessionRepository.prepareTurn(canonicalInput(f, null));
    await sessionRepository.bindEveSession(newer.id, "wrun_newer_task");
    await sessionRepository.parkSession({
      applicationSessionId: newer.id,
      pendingRequestId: "request-newer",
      requesterTelegramUserId: "canonical-owner",
      requesterUserId: f.userId,
    });
    await sessionRepository.recordTurnCompleted(newer.id, "wrun_newer_task", false, true);

    const [recovered, concurrent] = await Promise.all([
      sessionRepository.prepareTurn(canonicalInput(f, null)),
      sessionRepository.prepareTurn(canonicalInput(f, null)),
    ]);

    expect(staleTask.generation).toBe(0);
    expect(firstReplacement.generation).toBe(1);
    expect(newer.generation).toBe(2);
    expect(recovered.generation).toBe(3);
    // Either concurrent caller may acquire the database lock first; exactly one creates the generation.
    expect([recovered.rotated, concurrent.rotated].sort()).toEqual([false, true]);
    expect(concurrent.id).toBe(recovered.id);
    expect(recovered.sandboxSessionId).toBe(staleTask.sandboxSessionId);
    expect(recovered.continuationToken).toBe(
      `${canonicalInput(f, null).baseContinuationToken}:osinara:3`,
    );
    await expect(database().query(
      `SELECT 1 FROM conversation_sessions
        WHERE id = $1 AND kind = 'task' AND task_state = 'running' AND retired_at IS NULL`,
      [staleTask.id],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("promotes an OAuth authorization park without inventing a request identity", async () => {
    const f = await fixture();
    const canonical = await sessionRepository.prepareTurn(canonicalInput(f, 77));

    await sessionRepository.parkSession({
      applicationSessionId: canonical.id,
      pendingRequestId: null,
      requesterTelegramUserId: null,
      requesterUserId: null,
    });

    await expect(database().query(
      `SELECT 1 FROM conversation_sessions
        WHERE id = $1 AND kind = 'task' AND task_state = 'pending'
          AND pending_request_id IS NULL AND requester_user_id IS NULL
          AND requester_telegram_user_id IS NULL`,
      [canonical.id],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("preserves persisted requester identity when a later park has null metadata", async () => {
    const f = await fixture();
    const canonical = await sessionRepository.prepareTurn(canonicalInput(f, null));
    await sessionRepository.parkSession({
      applicationSessionId: canonical.id,
      pendingRequestId: "request-before-oauth",
      requesterTelegramUserId: "canonical-owner",
      requesterUserId: f.userId,
    });

    // OAuth authorization.required has no Eve request id and may lack a mapped application user.
    await sessionRepository.parkSession({
      applicationSessionId: canonical.id,
      pendingRequestId: null,
      requesterTelegramUserId: null,
      requesterUserId: null,
    });

    await expect(database().query(
      `SELECT 1 FROM conversation_sessions
        WHERE id = $1 AND pending_request_id = 'request-before-oauth'
          AND requester_user_id = $2 AND requester_telegram_user_id = 'canonical-owner'`,
      [canonical.id, f.userId],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it.each(["completed", "failed", "continuation"] as const)(
    "rolls back %s terminal state and route deletion when retirement audit fails",
    async (terminalPath) => {
    const f = await fixture();
    const canonical = await sessionRepository.prepareTurn(canonicalInput(f, null));
    await sessionRepository.bindEveSession(canonical.id, "wrun_atomic_terminal");
    await sessionRepository.parkSession({
      applicationSessionId: canonical.id,
      pendingRequestId: "request-atomic",
      requesterTelegramUserId: "canonical-owner",
      requesterUserId: f.userId,
    });
    await sessionRepository.registerRouteAlias(canonical.id, "-100-canonical::atomic");
    await database().query(`
      CREATE OR REPLACE FUNCTION reject_atomic_retirement_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.subject_id = '${canonical.id}' AND NEW.event_type = 'session.noncanonical_retired' THEN
          RAISE EXCEPTION 'forced retirement audit failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_atomic_retirement_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION reject_atomic_retirement_audit();
    `);

    try {
      const terminal = terminalPath === "completed"
        ? sessionRepository.recordTurnCompleted(canonical.id, "wrun_atomic_terminal", false, true)
        : terminalPath === "failed"
        ? sessionRepository.recordTurnFailed(canonical.id, "wrun_atomic_terminal")
        : sessionRepository.recordSessionFailedByContinuationToken(
          canonical.continuationToken,
          "wrun_atomic_terminal",
        );
      await expect(terminal).rejects.toThrow("forced retirement audit failure");
      await expect(database().query(
        `SELECT 1 FROM conversation_sessions
          WHERE id = $1 AND retired_at IS NULL AND task_state = 'pending'
            AND pending_operation = true`,
        [canonical.id],
      )).resolves.toMatchObject({ rowCount: 1 });
      await expect(sessionRepository.hasRoute("-100-canonical::atomic")).resolves.toBe(true);
    } finally {
      await database().query(`
        DROP TRIGGER reject_atomic_retirement_audit ON audit_events;
        DROP FUNCTION reject_atomic_retirement_audit();
      `);
    }
    },
  );

  it.each([
    ["completed", false],
    ["failed", true],
  ] as const)("retires a non-pending task after it is %s", async (_outcome, failed) => {
    const f = await fixture();
    const canonical = await sessionRepository.prepareTurn(canonicalInput(f, null));
    await sessionRepository.bindEveSession(canonical.id, "wrun_terminal_task");
    await sessionRepository.parkSession({
      applicationSessionId: canonical.id,
      pendingRequestId: "request-terminal",
      requesterTelegramUserId: "canonical-owner",
      requesterUserId: f.userId,
    });

    if (failed) {
      await sessionRepository.recordTurnFailed(canonical.id, "wrun_terminal_task");
    } else {
      await sessionRepository.recordTurnCompleted(canonical.id, "wrun_terminal_task", false, true);
    }

    await expect(database().query(
      `SELECT 1 FROM conversation_sessions
        WHERE id = $1 AND retired_at IS NOT NULL
          AND delete_after = retired_at + interval '1 day'
          AND task_state = $2`,
      [canonical.id, failed ? "failed" : "completed"],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("retires abandoned running tasks in the bounded lifecycle sweep", async () => {
    const f = await fixture();
    const canonical = await sessionRepository.prepareTurn(canonicalInput(f, null));
    await sessionRepository.bindEveSession(canonical.id, "wrun_abandoned_task");
    await sessionRepository.parkSession({
      applicationSessionId: canonical.id,
      pendingRequestId: "request-abandoned",
      requesterTelegramUserId: "canonical-owner",
      requesterUserId: f.userId,
    });
    await sessionRepository.resumePendingSession(canonical.id, "wrun_abandoned_task");
    await database().query(
      "UPDATE conversation_sessions SET last_activity_at = '2026-07-01T00:00:00.000Z' WHERE id = $1",
      [canonical.id],
    );

    await expect(sessionRepository.retireAbandonedTasks(
      new Date("2026-08-03T12:00:00.000Z"),
    )).resolves.toBe(1);
    await expect(database().query(
      "SELECT 1 FROM conversation_sessions WHERE id = $1 AND retired_at IS NOT NULL AND task_state = 'failed'",
      [canonical.id],
    )).resolves.toMatchObject({ rowCount: 1 });
  });
});
