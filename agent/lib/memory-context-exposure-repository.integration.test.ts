/**
 * Memory context exposure ledger tests.
 *
 * Constructs covered:
 * - Refs recorded within the window are reported as recently shown; older ones are not.
 * - The author card exposure follows its own, longer window.
 * - Recording the same ref again moves it to the newer turn and counts the show.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import { MEMORY_EXPOSURE_WINDOW_TURNS, PROFILE_AUTHOR_CARD_WINDOW_TURNS } from "./memory-config.js";
import { memoryContextExposureRepository } from "./memory-context-exposure-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

async function createSession(familyId: string, groupId: string): Promise<string> {
  const session = await database().query<{ id: string }>(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
        continuation_token, started_at, last_activity_at, completed_turns)
     VALUES (gen_random_uuid(), 0, $1, $2, 'family', 'canonical', 'exposure-test',
             'exposure-test', now(), now(), 30) RETURNING id`,
    [familyId, groupId],
  );
  return session.rows[0]!.id;
}

describeWithDatabase("memory context exposures", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("suppresses refs shown inside the window and releases older ones", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const sessionId = await createSession(fixture.familyId, fixture.groupId);
    await expect(memoryContextExposureRepository.sessionTurn(sessionId)).resolves.toBe(30);

    await memoryContextExposureRepository.record({
      applicationSessionId: sessionId, authorTelegramUserId: null, memoryRefs: ["mem_old"], sessionTurn: 30 - MEMORY_EXPOSURE_WINDOW_TURNS,
    });
    await memoryContextExposureRepository.record({
      applicationSessionId: sessionId, authorTelegramUserId: null, memoryRefs: ["mem_new", "mem_new"], sessionTurn: 29,
    });

    const shown = await memoryContextExposureRepository.recentlyShownMemoryRefs(sessionId, 30);
    expect([...shown]).toEqual(["mem_new"]);
    await expect(database().query(
      "SELECT shows FROM memory_context_exposures WHERE memory_ref = 'mem_new'",
    )).resolves.toMatchObject({ rows: [{ shows: 1 }] });

    await memoryContextExposureRepository.record({
      applicationSessionId: sessionId, authorTelegramUserId: null, memoryRefs: ["mem_new"], sessionTurn: 30,
    });
    await expect(database().query(
      "SELECT shows, session_turn FROM memory_context_exposures WHERE memory_ref = 'mem_new'",
    )).resolves.toMatchObject({ rows: [{ session_turn: 30, shows: 2 }] });
  });

  it("lists exactly the refs shown in one turn", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const sessionId = await createSession(fixture.familyId, fixture.groupId);
    await memoryContextExposureRepository.record({
      applicationSessionId: sessionId, authorTelegramUserId: null, memoryRefs: ["mem_earlier"], sessionTurn: 29,
    });
    await memoryContextExposureRepository.record({
      applicationSessionId: sessionId, authorTelegramUserId: null, memoryRefs: ["mem_block", "mem_search"], sessionTurn: 30,
    });

    const shown = await memoryContextExposureRepository.shownMemoryRefsForTurn(sessionId, 30);
    expect([...shown].sort()).toEqual(["mem_block", "mem_search"]);
    await expect(memoryContextExposureRepository.shownMemoryRefsForTurn(sessionId, 31)).resolves.toEqual(new Set());
  });

  it("tracks the author card with its own window", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const sessionId = await createSession(fixture.familyId, fixture.groupId);

    await memoryContextExposureRepository.record({
      applicationSessionId: sessionId, authorTelegramUserId: "101", memoryRefs: [], sessionTurn: 30 - PROFILE_AUTHOR_CARD_WINDOW_TURNS + 1,
    });

    await expect(memoryContextExposureRepository.authorCardShownRecently(sessionId, "101", 30)).resolves.toBe(true);
    await expect(memoryContextExposureRepository.authorCardShownRecently(sessionId, "202", 30)).resolves.toBe(false);
    await expect(memoryContextExposureRepository.authorCardShownRecently(sessionId, "101", 30 + PROFILE_AUTHOR_CARD_WINDOW_TURNS)).resolves.toBe(false);
  });
});
