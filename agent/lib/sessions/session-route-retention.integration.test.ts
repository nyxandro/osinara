/**
 * Session route resolution and retention isolation PostgreSQL tests.
 *
 * Constructs covered:
 * - Unbound delivery aliases retain the prepared session without becoming resumable early.
 * - Poisoned retention rows remain quarantined while later eligible rows make progress.
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
    "INSERT INTO families (name) VALUES ('Route retention') RETURNING id",
  );
  const user = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ('route-retention-owner', 'Owner') RETURNING id`,
  );
  await database().query(
    `INSERT INTO family_memberships (family_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [family.rows[0]!.id, user.rows[0]!.id],
  );
  return { familyId: family.rows[0]!.id, userId: user.rows[0]!.id };
}

describeWithDatabase("session route and retention isolation", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE conversation_session_routes, conversation_sessions, conversation_route_generations, telegram_groups, family_memberships, users, families CASCADE",
    );
  });
  afterAll(closeDatabase);

  it("keeps an unbound delivery alias attached to its prepared session", async () => {
    const f = await fixture();
    const current = await sessionRepository.prepareTurn({
      baseContinuationToken: "101::910",
      kind: "canonical",
      telegramForumTopicId: null,
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-07-12T12:00:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });
    await sessionRepository.registerRouteAlias(current.id, "101::911");

    // The alias is not resumable before the agent session binds, but prepareTurn must not fork the app session.
    await expect(sessionRepository.hasRoute("101::911")).resolves.toBe(false);
    const reply = await sessionRepository.prepareTurn({
      baseContinuationToken: "101::911",
      kind: "canonical",
      telegramForumTopicId: null,
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-07-12T12:01:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });
    expect(reply.id).toBe(current.id);
  });

  it("skips a poisoned retention row until its error is explicitly cleared", async () => {
    const f = await fixture();
    const inserted = await database().query<{ id: string }>(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, owner_user_id, scope, kind, conversation_key,
          continuation_token, eve_session_id, started_at, last_activity_at, retired_at,
          delete_after, cleanup_error_code)
       VALUES
         (gen_random_uuid(), 0, $1, $2, 'personal', 'canonical', 'poisoned', 'poisoned',
          'wrun_poisoned', now(), now(), now(), '2026-01-01', 'AGENT_STORAGE_CORRUPT'),
         (gen_random_uuid(), 0, $1, $2, 'personal', 'canonical', 'eligible', 'eligible',
          'wrun_eligible', now(), now(), now(), '2026-01-02', NULL)
       RETURNING id`,
      [f.familyId, f.userId],
    );

    const claim = await sessionRepository.claimExpiredForDeletion(
      new Date("2026-04-02T00:00:00.000Z"),
    );

    expect(claim).toMatchObject({ agentSessionId: "wrun_eligible", id: inserted.rows[1]!.id });
  });
});
