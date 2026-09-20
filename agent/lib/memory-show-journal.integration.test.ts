/**
 * The automatic selection remembering what it already showed.
 *
 * Constructs covered:
 * - `109_memory_retrieval_shows.sql`: a turn gets its number once, however many times it runs.
 * - A record shown inside the window is kept out of the next automatic selection.
 * - It comes back on its own once the window has moved past it.
 * - The explicit search is not bounded by the window at all.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_MODEL_VERSION,
  MEMORY_RETRIEVAL_RECENT_SHOW_WINDOW_TURNS,
} from "./memory-config.js";
import { memoryRetrievalRepository } from "./memory-retrieval-repository.js";
import { memoryShowJournal } from "./memory-show-journal.js";
import type { MemoryAuthorization } from "./memory-context.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = enabled ? describe : describe.skip;

function vector(first: number, second: number): number[] {
  return [first, second, ...Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS - 2 }, () => 0)];
}

describeWithDatabase("memory show journal", () => {
  let auth: MemoryAuthorization;
  let conversationId: string;
  let shownClaimId: string;

  beforeEach(async () => {
    await database().query(
      "TRUNCATE memory_embedding_chunks, memory_embedding_jobs, memory_items_all, application_conversations, family_memberships, users, families CASCADE",
    );
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Журнал показов') RETURNING id",
    );
    const user = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('shows-owner', 'Владелец') RETURNING id",
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [family.rows[0]!.id, user.rows[0]!.id],
    );
    // The personal conversation is created by a trigger on membership, not by hand.
    const conversation = await database().query<{ id: string }>(
      "SELECT id FROM application_conversations WHERE family_id = $1 AND owner_user_id = $2",
      [family.rows[0]!.id, user.rows[0]!.id],
    );
    conversationId = conversation.rows[0]!.id;
    auth = {
      familyId: family.rows[0]!.id,
      groupId: null,
      role: "owner",
      scopes: ["personal", "family"],
      telegramActorId: "shows-owner",
      telegramActorKind: "telegram_user",
      telegramUserId: "shows-owner",
      userId: user.rows[0]!.id,
    };
    const memory = await database().query<{ id: string }>(
      `INSERT INTO memory_items
         (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
          content, source, confirmation, sensitivity, operation_key, embedding_status)
       VALUES ($1, $2, $2, 'shows-owner', 'personal', 'fact', 'Код домофона 4271',
               'test:shows', 'user_confirmed', 'normal', 'shows-record', 'indexed')
       RETURNING id`,
      [auth.familyId, auth.userId],
    );
    shownClaimId = memory.rows[0]!.id;
    await database().query(
      `INSERT INTO memory_embedding_chunks
         (memory_item_id, chunk_index, content, embedding_input, start_offset, end_offset,
          embedding, embedding_model)
       VALUES ($1, 0, 'Код домофона 4271', 'Вид: факт. Код домофона 4271', 0, 17, $2::vector, $3)`,
      [shownClaimId, `[${vector(1, 0).join(",")}]`, MEMORY_EMBEDDING_MODEL_VERSION],
    );
  });

  afterAll(async () => closeDatabase());

  it("numbers a turn once, however many times that turn is processed", async () => {
    const first = await memoryShowJournal.openTurn(conversationId, "turn-a");
    const again = await memoryShowJournal.openTurn(conversationId, "turn-a");
    const next = await memoryShowJournal.openTurn(conversationId, "turn-b");

    expect({ first, again, next }).toEqual({ first: 1, again: 1, next: 2 });
  });

  it("keeps a record it just showed out of the next automatic selection", async () => {
    const first = {
      conversationId,
      turnId: "turn-1",
      turnOrdinal: await memoryShowJournal.openTurn(conversationId, "turn-1"),
    };
    const shown = await memoryRetrievalRepository.search(
      auth, "домофон", [vector(1, 0)], undefined, first,
    );
    expect(shown.results.map((result) => result.memory.id)).toEqual([shownClaimId]);
    await memoryShowJournal.recordShown(first, [shownClaimId]);

    const second = {
      conversationId,
      turnId: "turn-2",
      turnOrdinal: await memoryShowJournal.openTurn(conversationId, "turn-2"),
    };
    const repeated = await memoryRetrievalRepository.search(
      auth, "домофон", [vector(1, 0)], undefined, second,
    );

    expect(repeated.results).toEqual([]);
    expect(repeated.diagnostics.recentlyShown).toBe(1);
  });

  it("offers it again once the window has moved past it", async () => {
    const first = {
      conversationId,
      turnId: "turn-1",
      turnOrdinal: await memoryShowJournal.openTurn(conversationId, "turn-1"),
    };
    await memoryShowJournal.recordShown(first, [shownClaimId]);
    for (let turn = 2; turn <= MEMORY_RETRIEVAL_RECENT_SHOW_WINDOW_TURNS + 1; turn += 1) {
      await memoryShowJournal.openTurn(conversationId, `turn-${turn}`);
    }
    const later = {
      conversationId,
      turnId: `turn-${MEMORY_RETRIEVAL_RECENT_SHOW_WINDOW_TURNS + 2}`,
      turnOrdinal: await memoryShowJournal.openTurn(
        conversationId,
        `turn-${MEMORY_RETRIEVAL_RECENT_SHOW_WINDOW_TURNS + 2}`,
      ),
    };

    const { results } = await memoryRetrievalRepository.search(
      auth, "домофон", [vector(1, 0)], undefined, later,
    );

    expect(results.map((result) => result.memory.id)).toEqual([shownClaimId]);
  });

  it("never hides anything from a deliberate search", async () => {
    const first = {
      conversationId,
      turnId: "turn-1",
      turnOrdinal: await memoryShowJournal.openTurn(conversationId, "turn-1"),
    };
    await memoryShowJournal.recordShown(first, [shownClaimId]);

    // No window at all is what the explicit search tool passes.
    const { results } = await memoryRetrievalRepository.search(auth, "домофон", [vector(1, 0)]);

    expect(results.map((result) => result.memory.id)).toEqual([shownClaimId]);
  });
});
