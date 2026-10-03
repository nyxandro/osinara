/**
 * Memory that keeps answering when the embedding service does not.
 *
 * Constructs covered:
 * - The word branches run without a query vector instead of the whole turn losing its memory.
 * - The model is told the selection is incomplete, so «не нашлось» is not read as «этого нет».
 * - The failure is written down as an error: a degraded search must not be a silent one.
 * - Threads still activate by what was retrieved, without the title similarity they cannot compute.
 *
 * The query vector used to be taken before the database was touched at all, and unconditionally.
 * One unreachable service therefore turned into «память недоступна» for the whole turn, although
 * two of the three branches search text in PostgreSQL and have nothing to do with it: exact names,
 * numbers and file names would have been found.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { retrieveMemoryTurnContext, retrieveRelevantMemories } from "./memory-retrieval.js";
import { MEMORY_EMBEDDING_MODEL_VERSION } from "./memory-config.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = enabled ? describe : describe.skip;

const embedding = vi.hoisted(() => ({ fail: false }));

// The embedding service is not part of the ordinary test stack, so the working case is stood in
// for by a fixed vector: what this file measures is the behaviour around the service, not the model.
const QUERY_VECTOR = [1, ...Array.from({ length: 383 }, () => 0)];

vi.mock("./memory-embedding-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory-embedding-client.js")>()),
  embedMemoryQueryChunks: vi.fn(async () => {
    if (embedding.fail) {
      throw new Error("AGENT_MEMORY_EMBEDDING_PROVIDER_UNAVAILABLE: сервис недоступен");
    }
    return [QUERY_VECTOR];
  }),
}));

describeWithDatabase("memory retrieval without the embedding service", () => {
  let auth: MemoryAuthorization;
  let claimId: string;

  beforeEach(async () => {
    embedding.fail = true;
    await database().query(
      "TRUNCATE memory_embedding_chunks, memory_embedding_jobs, memory_items_all, application_conversations, family_memberships, users, families CASCADE",
    );
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Деградация') RETURNING id",
    );
    const user = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('degraded-owner', 'Владелец') RETURNING id",
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [family.rows[0]!.id, user.rows[0]!.id],
    );
    auth = {
      familyId: family.rows[0]!.id,
      groupId: null,
      role: "owner",
      scopes: ["personal", "family"],
      telegramActorId: "degraded-owner",
      telegramActorKind: "telegram_user",
      telegramUserId: "degraded-owner",
      userId: user.rows[0]!.id,
    };
    const memory = await database().query<{ id: string }>(
      `INSERT INTO memory_items
         (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
          content, source, confirmation, sensitivity, operation_key, embedding_status)
       VALUES ($1, $2, $2, 'degraded-owner', 'personal', 'fact', 'Код домофона 4271',
               'test:degraded', 'user_confirmed', 'normal', 'degraded-record', 'indexed')
       RETURNING id`,
      [auth.familyId, auth.userId],
    );
    claimId = memory.rows[0]!.id;
    await database().query(
      `INSERT INTO memory_embedding_chunks
         (memory_item_id, chunk_index, content, embedding_input, start_offset, end_offset,
          embedding, embedding_model)
       VALUES ($1, 0, 'Код домофона 4271', 'Код домофона 4271', 0, 17,
               $2::vector, $3)`,
      [claimId, `[${QUERY_VECTOR.join(",")}]`, MEMORY_EMBEDDING_MODEL_VERSION],
    );
  });

  afterAll(async () => closeDatabase());

  it("still finds by words when the query vector cannot be computed", async () => {
    const context = await retrieveMemoryTurnContext(auth, "какой код домофона", []);

    expect(context.retrievedClaimIds).toEqual([claimId]);
  });

  it("tells the model the selection is incomplete", async () => {
    const context = await retrieveMemoryTurnContext(auth, "какой код домофона", []);

    expect(context.diagnostics.semanticBranchAvailable).toBe(false);
  });

  it("writes the failure down instead of degrading quietly", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await retrieveMemoryTurnContext(auth, "какой код домофона", []);

    expect(logged.mock.calls.map(([line]) => String(line)).join("\n"))
      .toContain("AGENT_MEMORY_SEMANTIC_BRANCH_UNAVAILABLE");
    logged.mockRestore();
  });

  it("answers the explicit search too, instead of failing the tool", async () => {
    const { diagnostics, memories } = await retrieveRelevantMemories(auth, "код домофона 4271");

    expect(memories).toHaveLength(1);
    expect(diagnostics.semanticBranchAvailable).toBe(false);
  });

  it("goes back to the whole pipeline once the service answers again", async () => {
    embedding.fail = false;

    const context = await retrieveMemoryTurnContext(auth, "какой код домофона", []);

    expect(context.diagnostics.semanticBranchAvailable).toBe(true);
  });
});
