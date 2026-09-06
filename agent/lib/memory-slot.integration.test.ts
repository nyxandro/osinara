/**
 * Memory slot integration tests.
 *
 * Constructs covered:
 * - A profile claim persists its attribute slot.
 * - A newer claim in the same subject slot supersedes the older one and keeps it as a version.
 * - An identical claim in the slot is reinforced, not duplicated.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import type { CreateMemoryInput } from "./memory-record.js";
import { memoryRepository } from "./memory-repository.js";
import { memoryRetrievalRepository } from "./memory-retrieval-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

function slotInput(
  fixture: { conversationId: string; timelineEntryId: string },
  content: string,
  operationKey: string,
): CreateMemoryInput {
  return {
    attribute: "работа",
    confirmation: "model_high",
    content,
    explicitSource: {
      conversationId: fixture.conversationId,
      subject: { kind: "current_author" },
      timelineEntryId: fixture.timelineEntryId,
    },
    kind: "profile",
    operationKey,
    provenance: { sessionId: "eve-session-slot", turnId: `eve-turn-${operationKey}` },
    scope: "family",
    sensitivity: "normal",
    source: `eve:eve-session-slot:eve-turn-${operationKey}`,
  };
}

describeWithDatabase("memory slots", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("persists the attribute slot of a profile claim", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const memory = await memoryRepository.create(
      fixture.auth,
      slotInput(fixture, "Анна работает логистом", "slot-1"),
    );

    await expect(database().query(
      "SELECT attribute FROM memory_items WHERE id = $1",
      [memory.id],
    )).resolves.toMatchObject({ rows: [{ attribute: "работа" }] });
  });

  it("supersedes the previous claim in the same subject slot", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const first = await memoryRepository.create(
      fixture.auth,
      slotInput(fixture, "Анна работает логистом", "slot-a"),
    );
    const second = await memoryRepository.create(
      fixture.auth,
      slotInput(fixture, "Анна ушла в IT, теперь тестировщик", "slot-b"),
    );

    await expect(database().query(
      "SELECT claim_status::text, superseded_by FROM memory_items_all WHERE id = $1",
      [first.id],
    )).resolves.toMatchObject({ rows: [{ claim_status: "superseded", superseded_by: second.id }] });
    await expect(database().query(
      `SELECT relation_type::text, detection_method, detection_metadata->>'method' AS method
         FROM claim_relations WHERE source_claim_id = $1 AND target_claim_id = $2`,
      [first.id, second.id],
    )).resolves.toMatchObject({
      rows: [{ detection_method: "deterministic_exact", method: "slot_attribute", relation_type: "temporal_update" }],
    });
    const active = await database().query<{ id: string }>(
      `SELECT id FROM memory_items WHERE family_id = $1 AND scope = 'family'
        AND claim_status = 'active'`,
      [fixture.familyId],
    );
    expect(active.rows.map((row) => row.id)).toEqual([second.id]);
  });

  it("shares one slot across semantic kinds for a labelled subject, but not with episodes", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const labelled = (content: string, kind: CreateMemoryInput["kind"], attribute: string, operationKey: string): CreateMemoryInput => ({
      ...slotInput(fixture, content, operationKey),
      attribute,
      explicitSource: {
        conversationId: fixture.conversationId,
        subject: { kind: "label", label: "Гоша" },
        timelineEntryId: fixture.timelineEntryId,
      },
      kind,
    });
    const fact = await memoryRepository.create(fixture.auth, labelled("Гоша живёт в клетке, но его выпускают", "fact", "содержание", "gosha-1"));
    const shared = await memoryRepository.create(fixture.auth, labelled("Гоша живёт не в клетке, а на жёрдочке", "family_shared", "содержание", "gosha-2"));
    await expect(database().query(
      "SELECT claim_status::text, superseded_by FROM memory_items_all WHERE id = $1",
      [fact.id],
    )).resolves.toMatchObject({ rows: [{ claim_status: "superseded", superseded_by: shared.id }] });

    // A discussion summary is an episode slot of its own and leaves the fact chain alone.
    const summary = await memoryRepository.create(fixture.auth, labelled("Обсудили содержание Гоши: решили оставить жёрдочку", "episode", "итог обсуждения", "gosha-3"));
    const summaryAgain = await memoryRepository.create(fixture.auth, labelled("Обсудили содержание Гоши ещё раз: жёрдочка и клетка на ночь", "episode", "итог обсуждения", "gosha-4"));
    await expect(database().query(
      "SELECT claim_status::text FROM memory_items_all WHERE id = ANY($1::uuid[]) ORDER BY created_at",
      [[shared.id, summary.id, summaryAgain.id]],
    )).resolves.toMatchObject({ rows: [{ claim_status: "active" }, { claim_status: "superseded" }, { claim_status: "active" }] });
  });

  it("reinforces an identical claim in the slot instead of creating a version", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const first = await memoryRepository.create(
      fixture.auth,
      slotInput(fixture, "Анна работает логистом", "slot-c"),
    );
    const again = await memoryRepository.create(
      fixture.auth,
      slotInput(fixture, "Анна работает логистом", "slot-d"),
    );

    expect(again.id).toBe(first.id);
    await expect(database().query(
      "SELECT claim_status::text, reinforcement_count FROM memory_items WHERE id = $1",
      [first.id],
    )).resolves.toMatchObject({ rows: [{ claim_status: "active", reinforcement_count: 1 }] });
  });

  it("stores the event date of an episode and filters retrieval by a date window", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const episode = await memoryRepository.create(fixture.auth, {
      confirmation: "model_high",
      content: "Анна ездила в Питер на конференцию",
      explicitSource: {
        conversationId: fixture.conversationId,
        subject: { kind: "current_author" },
        timelineEntryId: fixture.timelineEntryId,
      },
      kind: "episode",
      occurredAt: "2026-09-08",
      operationKey: "episode-1",
      provenance: { sessionId: "eve-session-ep", turnId: "eve-turn-ep" },
      scope: "family",
      sensitivity: "normal",
      source: "eve:eve-session-ep:eve-turn-ep",
    });

    expect(episode.occurredAt).toBe("2026-09-08T00:00:00.000Z");
    const zero = Array.from({ length: 384 }, () => 0);
    const inside = await memoryRetrievalRepository.search(fixture.auth, "Питер", zero, 12, {
      occurredAfter: "2026-09-01",
      occurredBefore: "2026-09-30",
    });
    const outside = await memoryRetrievalRepository.search(fixture.auth, "Питер", zero, 12, {
      occurredAfter: "2026-10-01",
    });
    expect(inside.map((result) => result.memory.id)).toContain(episode.id);
    expect(outside.map((result) => result.memory.id)).not.toContain(episode.id);
  });
});
