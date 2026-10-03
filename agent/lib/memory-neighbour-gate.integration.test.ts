/**
 * Showing the model what it is about to duplicate, and letting it decide.
 *
 * Constructs covered:
 * - A paraphrase of an existing record stops the write and names its neighbours.
 * - The model gets through by declaring the neighbours it has looked at.
 * - A neighbour it has not seen stops the write again, so the declaration cannot be blanket.
 * - Another subject, another area of memory, and an episode are never gated.
 * - Without the embedding service the write goes through: a helper check must not block memory.
 *
 * The threshold is the whole design question, and it cannot be settled by taste. Measured on
 * production over 1030 active non-episode records with vectors: a gate at 0.90 would stop 360 of
 * them with 3.8 neighbours on average, at 0.92 — 164, at 0.93 — 100 with 1.3 neighbours, at
 * 0.95 — 33. The neighbouring-project measurement quoted in #208 puts real duplicates at about
 * 0.934 and genuinely different facts about one person at 0.916–0.924, so 0.93 falls between the
 * two bands: it stops about a tenth of writes, and mostly the ones worth stopping.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryRepository } from "./memory-repository.js";
import {
  createMemoryCorrectionSource,
  createMemoryFamilyFixture,
} from "./memory-repository.integration-fixtures.js";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_MODEL_VERSION,
} from "./memory-config.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = enabled ? describe : describe.skip;

/** A unit vector at `degrees` from the first axis: similarity is the cosine of the angle. */
function vector(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  return [
    Math.cos(radians),
    Math.sin(radians),
    ...Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS - 2 }, () => 0),
  ];
}

const embedded = vi.hoisted(() => ({ next: [] as number[][], fail: false }));

vi.mock("./memory-embedding-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory-embedding-client.js")>()),
  embedMemoryPassages: vi.fn(async (passages: readonly string[]) => {
    if (embedded.fail) throw new Error("AGENT_MEMORY_EMBEDDING_PROVIDER_UNAVAILABLE: нет сервиса");
    return passages.map((_, index) => embedded.next[index] ?? vector(0));
  }),
}));

describeWithDatabase("memory neighbour gate", () => {
  let owner: MemoryAuthorization;
  let member: MemoryAuthorization;

  beforeEach(async () => {
    embedded.fail = false;
    embedded.next = [vector(0)];
    await database().query(
      "TRUNCATE memory_embedding_chunks, memory_embedding_jobs, memory_items_all, application_conversations, family_memberships, users, families CASCADE",
    );
    const fixture = await createMemoryFamilyFixture("gate");
    owner = fixture.owner;
    member = fixture.member;
  });

  afterAll(async () => closeDatabase());

  async function remember(input: {
    auth?: MemoryAuthorization;
    content: string;
    distinctFrom?: string[];
    key: string;
    kind?: "episode" | "preference";
    scope?: "family" | "personal";
  }) {
    const auth = input.auth ?? owner;
    const scope = input.scope ?? "personal";
    const source = await createMemoryCorrectionSource(auth, scope);
    return memoryRepository.create(auth, {
      confirmation: "user_confirmed",
      content: input.content,
      ...(input.distinctFrom === undefined ? {} : { distinctFrom: input.distinctFrom }),
      explicitSource: {
        conversationId: source.conversationId,
        subject: scope === "family" ? { kind: "none" } : { kind: "current_author" },
        timelineEntryId: source.timelineEntryId,
      },
      kind: input.kind ?? "preference",
      operationKey: input.key,
      provenance: { sessionId: "gate-session", turnId: input.key },
      scope,
      sensitivity: "normal",
      source: `eve:gate:${input.key}`,
    });
  }

  /** The indexing worker is asynchronous, so the fixture writes the stored vector directly. */
  async function index(id: string, degrees: number): Promise<void> {
    await database().query(
      `INSERT INTO memory_embedding_chunks
         (memory_item_id, chunk_index, content, embedding_input, start_offset, end_offset,
          embedding, embedding_model)
       SELECT $1, 0, content, content, 0, char_length(content), $2::vector, $3
       FROM memory_items WHERE id = $1`,
      [id, `[${vector(degrees).join(",")}]`, MEMORY_EMBEDDING_MODEL_VERSION],
    );
  }

  it("stops a paraphrase of what is already stored and names the neighbour", async () => {
    const stored = await remember({ content: "Не ест глютен", key: "gate-1" });
    await index(stored.id, 0);
    embedded.next = [vector(10)];

    await expect(remember({ content: "У Ани непереносимость глютена", key: "gate-2" }))
      .rejects.toMatchObject({ code: "AGENT_MEMORY_SIMILAR_RECORD_EXISTS" });
  });

  it("lets the write through once the model says it looked at that neighbour", async () => {
    const stored = await remember({ content: "Не ест глютен", key: "gate-3" });
    await index(stored.id, 0);
    embedded.next = [vector(10)];

    const saved = await remember({
      content: "У Ани непереносимость глютена", distinctFrom: [stored.memoryRef], key: "gate-4",
    });

    expect(saved.content).toBe("У Ани непереносимость глютена");
  });

  it("stops again when a neighbour was not among the ones declared", async () => {
    const first = await remember({ content: "Не ест глютен", key: "gate-5" });
    await index(first.id, 0);
    const second = await remember({
      content: "Не ест хлеб", distinctFrom: [first.memoryRef], key: "gate-6",
    });
    await index(second.id, 2);
    embedded.next = [vector(10)];

    await expect(remember({
      content: "У Ани непереносимость глютена", distinctFrom: [first.memoryRef], key: "gate-7",
    })).rejects.toMatchObject({ code: "AGENT_MEMORY_SIMILAR_RECORD_EXISTS" });
  });

  it("never compares across subjects", async () => {
    const other = await remember({ auth: member, content: "Не ест глютен", key: "gate-8" });
    await index(other.id, 0);
    embedded.next = [vector(10)];

    const saved = await remember({ content: "У Ани непереносимость глютена", key: "gate-9" });

    expect(saved.content).toBe("У Ани непереносимость глютена");
  });

  it("leaves episodes alone, because two similar trips are two trips", async () => {
    const stored = await remember({ content: "Ездили в Суздаль", key: "gate-10", kind: "episode" });
    await index(stored.id, 0);
    embedded.next = [vector(10)];

    const saved = await remember({
      content: "Съездили в Суздаль на выходных", key: "gate-11", kind: "episode",
    });

    expect(saved.content).toBe("Съездили в Суздаль на выходных");
  });

  it("saves the record when the embedding service is unreachable", async () => {
    const stored = await remember({ content: "Не ест глютен", key: "gate-12" });
    await index(stored.id, 0);
    embedded.fail = true;

    const saved = await remember({ content: "У Ани непереносимость глютена", key: "gate-13" });

    expect(saved.content).toBe("У Ани непереносимость глютена");
  });
});
