/**
 * The vector index has to be used, and the access rules have to survive it.
 *
 * Constructs covered:
 * - `107_memory_vector_index_iterative_scan.sql`: the database asks pgvector to keep scanning.
 * - The statement the product runs is planned as an index walk ordered by distance.
 * - The access rules sit above that walk and below its limit, so the limit cannot outrun them.
 * - The branch still arrives full once the rules have thinned the index's output.
 * - A family sees only its own records through that path, whatever order the index offers them.
 *
 * Why this is asserted at all: the index was built on day one and no query ever used it, because
 * the shape of the statement did not match what pgvector can serve. Nothing failed when that
 * happened, and nobody noticed for a year. This test is what fails instead.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { MEMORY_EMBEDDING_DIMENSIONS, MEMORY_EMBEDDING_MODEL_VERSION } from "./memory-config.js";
import {
  memoryRetrievalRepository,
  memoryRetrievalSearchParameters,
  memoryRetrievalSearchStatement,
} from "./memory-retrieval-repository.js";
import type { MemoryAuthorization } from "./memory-context.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = enabled ? describe : describe.skip;

const VECTOR_INDEX = "memory_embedding_chunks_vector_idx";
// The family owns most of the corpus, as it does in production: a single-family database is the
// case the plan has to hold for. The foreign records are few, and they sit closest to the query.
const OWN_RECORDS = 150;
const FOREIGN_RECORDS = 30;
// Measured against `hnsw.iterative_scan = off` on this fixture: the index hands over one portion,
// the foreign chunks nearest the query are discarded, and the branch arrives with about ten
// records instead of forty.
const SEMANTIC_RECORDS_WITHOUT_ITERATIVE_SCAN = 10;

/**
 * A narrow fan of unit vectors: every one of them stays within the semantic gate of the query at
 * seed zero, so the branch under test actually produces candidates instead of being cut by the
 * threshold before the index matters.
 */
function vector(seed: number): number[] {
  const angle = (seed % 36) * (Math.PI / 180);
  return [
    Math.cos(angle),
    Math.sin(angle),
    ...Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS - 2 }, () => 0),
  ];
}

describeWithDatabase("semantic branch uses the vector index", () => {
  let auth: MemoryAuthorization;
  let foreignFamilyId: string;

  beforeAll(async () => {
    await database().query(
      "TRUNCATE memory_embedding_chunks, memory_embedding_jobs, memory_items_all, family_memberships, users, families CASCADE",
    );
    const families = await database().query<{ id: string; name: string }>(
      "INSERT INTO families (name) VALUES ('Своя'), ('Чужая') RETURNING id, name",
    );
    const own = families.rows.find((row) => row.name === "Своя")!;
    foreignFamilyId = families.rows.find((row) => row.name === "Чужая")!.id;
    const users = await database().query<{ id: string; telegram_user_id: string }>(
      `INSERT INTO users (telegram_user_id, display_name)
       VALUES ('index-own', 'Свой'), ('index-foreign', 'Чужой')
       RETURNING id, telegram_user_id`,
    );
    const ownUser = users.rows.find((row) => row.telegram_user_id === "index-own")!;
    const foreignUser = users.rows.find((row) => row.telegram_user_id === "index-foreign")!;
    await database().query(
      `INSERT INTO family_memberships (family_id, user_id, role)
       VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
      [own.id, ownUser.id, foreignFamilyId, foreignUser.id],
    );
    auth = {
      familyId: own.id,
      groupId: null,
      role: "owner",
      scopes: ["personal", "family"],
      telegramActorId: "index-own",
      telegramActorKind: "telegram_user",
      telegramUserId: "index-own",
      userId: ownUser.id,
    };

    // The foreign records sit closest to the query, so an index scan that forgot the access rules
    // would hand them over first.
    const rows: Array<[string, string, string, number, string]> = [];
    for (let index = 0; index < OWN_RECORDS; index += 1) {
      rows.push([own.id, ownUser.id, "index-own", 6 + (index % 30), `own-${index}`]);
    }
    for (let index = 0; index < FOREIGN_RECORDS; index += 1) {
      rows.push([foreignFamilyId, foreignUser.id, "index-foreign", index % 6, `foreign-${index}`]);
    }
    for (const [familyId, userId, telegramUserId, seed, key] of rows) {
      const memory = await database().query<{ id: string }>(
        `INSERT INTO memory_items
           (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
            content, source, confirmation, sensitivity, operation_key, embedding_status)
         VALUES ($1, $2, $2, $3, 'personal', 'fact', $4, 'test:index',
                 'user_confirmed', 'normal', $5, 'indexed')
         RETURNING id`,
        [familyId, userId, telegramUserId, `Запись ${key}`, key],
      );
      await database().query(
        `INSERT INTO memory_embedding_chunks
           (memory_item_id, chunk_index, content, embedding_input, start_offset, end_offset,
            embedding, embedding_model)
         VALUES ($1, 0, $2, $2, 0, $3, $4::vector, $5)`,
        [
          memory.rows[0]!.id,
          `Запись ${key}`,
          `Запись ${key}`.length,
          `[${vector(seed).join(",")}]`,
          MEMORY_EMBEDDING_MODEL_VERSION,
        ],
      );
    }
    await database().query("ANALYZE memory_embedding_chunks");
    await database().query("ANALYZE memory_items_all");
  }, 300_000);

  afterAll(async () => closeDatabase());

  it("asks pgvector to keep scanning until the access rules are satisfied", async () => {
    const setting = await database().query<{ setting: string }>(
      "SELECT current_setting('hnsw.iterative_scan') AS setting",
    );

    expect(setting.rows[0]?.setting).toBe("relaxed_order");
  });

  it("plans the real search statement as an index walk ordered by distance", async () => {
    // The statement the product runs, not a copy of it: a copy would keep passing while the
    // branch itself drifted back to a form the index cannot serve, which is how the index went
    // unused for a year without anything failing.
    const plan = await database().query<{ "QUERY PLAN": string }>(
      `EXPLAIN ${memoryRetrievalSearchStatement()}`,
      memoryRetrievalSearchParameters(auth, "запись", [vector(0)]),
    );
    const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");

    expect({ usesIndex: text.includes(VECTOR_INDEX), plan: text })
      .toEqual({ usesIndex: true, plan: text });
    expect({ ordersByDistance: text.includes("Order By: (embedding <=>"), plan: text })
      .toEqual({ ordersByDistance: true, plan: text });
  });

  it("keeps the access rules above the index, where the limit cannot outrun them", async () => {
    const plan = await database().query<{ "QUERY PLAN": string }>(
      `EXPLAIN ${memoryRetrievalSearchStatement()}`,
      memoryRetrievalSearchParameters(auth, "запись", [vector(0)]),
    );
    const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
    const indexLine = text.split("\n").findIndex((line) => line.includes(VECTOR_INDEX));
    const semiJoinLine = text.split("\n").findIndex((line) => line.includes("Semi Join"));

    // The filter has to sit above the ordered scan and below the limit; the other way round the
    // approximate walk would hand over a fixed portion and the access rules would thin it out.
    expect({ filterAboveIndex: semiJoinLine >= 0 && semiJoinLine < indexLine, plan: text })
      .toEqual({ filterAboveIndex: true, plan: text });
  });

  it("keeps the branch full despite the access rules, which is what iterative scan is for", async () => {
    // Without `hnsw.iterative_scan` the index hands over one portion, the foreign chunks nearest
    // the query are thrown away, and the branch arrives short. The number is the measurement.
    const { diagnostics } = await memoryRetrievalRepository.search(auth, "запись", [vector(0)]);

    expect(diagnostics.semanticQualified)
      .toBeGreaterThan(SEMANTIC_RECORDS_WITHOUT_ITERATIVE_SCAN * 2);
  });

  it("returns only this family's records through the index", async () => {
    const { results } = await memoryRetrievalRepository.search(auth, "запись", [vector(0)]);

    expect(results.length).toBeGreaterThan(0);
    const foreign = await database().query<{ count: string }>(
      `SELECT count(*) AS count FROM memory_items
       WHERE family_id = $1 AND id = ANY($2::uuid[])`,
      [foreignFamilyId, results.map((result) => result.memory.id)],
    );
    expect(Number(foreign.rows[0]?.count)).toBe(0);
  });
});
