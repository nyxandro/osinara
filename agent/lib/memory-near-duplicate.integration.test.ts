/**
 * Near-duplicate gate integration tests.
 *
 * Constructs covered:
 * - A close active record of the same subject blocks a plain insert with the candidate list.
 * - `reinforces` bumps the existing record; `distinct` inserts anyway; a slot write skips the gate.
 * - A different subject or an episode is never gated.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./memory-embedding-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./memory-embedding-client.js")>(),
  embedMemoryQuery: vi.fn(async () => [1, ...Array.from({ length: 383 }, () => 0)]),
}));

import { closeDatabase, database } from "./database.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import { MEMORY_EMBEDDING_MODEL_VERSION } from "./memory-config.js";
import type { CreateMemoryInput } from "./memory-record.js";
import { memoryRepository } from "./memory-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

type Fixture = Awaited<ReturnType<typeof createMainAgentMemoryFixture>>;

function claim(
  fixture: Fixture,
  content: string,
  operationKey: string,
  overrides: Partial<CreateMemoryInput> & { subject?: CreateMemoryInput["explicitSource"] extends infer S ? S extends { subject: infer U } ? U : never : never } = {},
): CreateMemoryInput {
  const { subject, ...rest } = overrides;
  return {
    confirmation: "model_high",
    content,
    explicitSource: {
      conversationId: fixture.conversationId,
      subject: subject ?? { kind: "label", label: "Гоша" },
      timelineEntryId: fixture.timelineEntryId,
    },
    kind: "family_shared",
    operationKey,
    provenance: { sessionId: "eve-session-near", turnId: `eve-turn-${operationKey}` },
    scope: "family",
    sensitivity: "normal",
    source: `eve:eve-session-near:eve-turn-${operationKey}`,
    ...rest,
  };
}

async function indexWithVector(memoryId: string, first: number): Promise<void> {
  const embedding = `[${[first, ...Array.from({ length: 383 }, () => 0)].join(",")}]`;
  await database().query(
    `INSERT INTO memory_embedding_chunks
       (memory_item_id, chunk_index, content, start_offset, end_offset, embedding, embedding_model)
     VALUES ($1, 0, 'chunk', 0, 5, $2::vector, $3)`,
    [memoryId, embedding, MEMORY_EMBEDDING_MODEL_VERSION],
  );
  await database().query("UPDATE memory_items SET embedding_status = 'indexed' WHERE id = $1", [memoryId]);
}

describeWithDatabase("near-duplicate gate", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE memory_embedding_chunks, users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("refuses a near duplicate until the writer decides, then reinforces or inserts", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const first = await memoryRepository.create(fixture.auth, claim(fixture, "Гоша, кубинский амазон, живёт у семьи дома", "near-1"));
    await indexWithVector(first.id, 1);

    await expect(memoryRepository.create(fixture.auth, claim(fixture, "Семейный попугай Гоша, кубинский амазон, живёт дома", "near-2")))
      .rejects.toMatchObject({ code: "AGENT_MEMORY_NEAR_DUPLICATE", message: expect.stringContaining(first.memoryRef) });
    await expect(database().query(
      "SELECT count(*)::int AS total FROM memory_items WHERE family_id = $1",
      [fixture.familyId],
    )).resolves.toMatchObject({ rows: [{ total: 1 }] });

    const reinforced = await memoryRepository.reinforceByRef(fixture.auth, {
      memoryRef: first.memoryRef,
      provenance: { sessionId: "eve-session-near", turnId: "eve-turn-near-3" },
    });
    expect(reinforced.memoryRef).toBe(first.memoryRef);
    await expect(database().query(
      "SELECT reinforcement_count FROM memory_items WHERE id = $1",
      [first.id],
    )).resolves.toMatchObject({ rows: [{ reinforcement_count: 1 }] });

    const distinct = await memoryRepository.create(fixture.auth, claim(fixture, "Семейный попугай Гоша, кубинский амазон, живёт дома", "near-4", { distinct: true }));
    expect(distinct.id).not.toBe(first.id);

    // A slot write supersedes through the slot instead of asking.
    const slotted = await memoryRepository.create(fixture.auth, claim(fixture, "Гоша живёт на жёрдочке, клетка только на ночь", "near-5", { attribute: "содержание" }));
    expect(slotted.id).not.toBe(first.id);
  });

  it("never gates another subject or an episode", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const first = await memoryRepository.create(fixture.auth, claim(fixture, "Гоша живёт у семьи дома", "other-1"));
    await indexWithVector(first.id, 1);

    await expect(memoryRepository.create(fixture.auth, claim(fixture, "Гоша живёт у семьи дома", "other-2", {
      subject: { kind: "label", label: "Кеша" },
    }))).resolves.toMatchObject({ kind: "family_shared" });
    await expect(memoryRepository.create(fixture.auth, claim(fixture, "Гоша сегодня летал по комнате", "other-3", {
      kind: "episode",
    }))).resolves.toMatchObject({ kind: "episode" });
  });
});
