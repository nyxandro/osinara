/**
 * Counting a record as used only when this turn had actually shown it.
 *
 * Constructs covered:
 * - `110_memory_usage_counter.sql`: usage is counted apart from reinforcement.
 * - A record shown in this turn is counted once per turn it was named in.
 * - A ref the turn never showed is rejected and changes nothing.
 * - A ref from an earlier turn of the same conversation is rejected too.
 * - Processing one turn twice counts the record once.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { memoryShowJournal } from "./memory-show-journal.js";
import { memoryUsageRepository } from "./memory-usage-repository.js";

const SESSION = "wrun_usage";
const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase("memory usage counter", () => {
  let conversationId: string;
  let shownRef: string;
  let shownId: string;
  let hiddenRef: string;

  beforeEach(async () => {
    await database().query(
      "TRUNCATE memory_embedding_chunks, memory_embedding_jobs, memory_items_all, application_conversations, family_memberships, users, families CASCADE",
    );
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Счётчик использования') RETURNING id",
    );
    const user = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('usage-owner', 'Владелец') RETURNING id",
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [family.rows[0]!.id, user.rows[0]!.id],
    );
    const conversation = await database().query<{ id: string }>(
      "SELECT id FROM application_conversations WHERE family_id = $1 AND owner_user_id = $2",
      [family.rows[0]!.id, user.rows[0]!.id],
    );
    conversationId = conversation.rows[0]!.id;

    // The opaque ref is written by a trigger, so it is only visible to a later statement.
    const insert = async (key: string) => {
      const memory = await database().query<{ id: string }>(
        `INSERT INTO memory_items
           (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
            content, source, confirmation, sensitivity, operation_key)
         VALUES ($1, $2, $2, 'usage-owner', 'personal', 'fact', $3, 'test:usage',
                 'user_confirmed', 'normal', $3)
         RETURNING id`,
        [family.rows[0]!.id, user.rows[0]!.id, key],
      );
      const ref = await database().query<{ memory_ref: string }>(
        "SELECT memory_ref FROM memory_item_refs WHERE memory_item_id = $1",
        [memory.rows[0]!.id],
      );
      return { id: memory.rows[0]!.id, memory_ref: ref.rows[0]!.memory_ref };
    };
    const shown = await insert("показанная");
    shownId = shown.id;
    shownRef = shown.memory_ref;
    hiddenRef = (await insert("непоказанная")).memory_ref;
  });

  afterAll(async () => closeDatabase());

  async function usageOf(id: string): Promise<{ count: number; used: boolean }> {
    const row = await database().query<{ last_used_at: Date | null; usage_count: number }>(
      "SELECT usage_count, last_used_at FROM memory_items WHERE id = $1",
      [id],
    );
    return { count: row.rows[0]!.usage_count, used: row.rows[0]!.last_used_at !== null };
  }

  it("counts a record the turn had shown and refuses one it had not", async () => {
    const window = {
      conversationId,
      eveSessionId: SESSION,
      turnId: "turn-1",
      turnOrdinal: await memoryShowJournal.openTurn(conversationId, SESSION, "turn-1"),
    };
    await memoryShowJournal.recordShown(window, [shownId]);

    const outcome = await memoryUsageRepository.recordUsed(window, [shownRef, hiddenRef]);

    expect(outcome).toEqual({ counted: [shownRef], rejected: [hiddenRef], used: [shownRef] });
    expect(await usageOf(shownId)).toEqual({ count: 1, used: true });
  });

  it("refuses a ref that belongs to an earlier turn of the same conversation", async () => {
    const first = {
      conversationId,
      eveSessionId: SESSION,
      turnId: "turn-1",
      turnOrdinal: await memoryShowJournal.openTurn(conversationId, SESSION, "turn-1"),
    };
    await memoryShowJournal.recordShown(first, [shownId]);
    const second = {
      conversationId,
      eveSessionId: SESSION,
      turnId: "turn-2",
      turnOrdinal: await memoryShowJournal.openTurn(conversationId, SESSION, "turn-2"),
    };

    const outcome = await memoryUsageRepository.recordUsed(second, [shownRef]);

    expect(outcome).toEqual({ counted: [], rejected: [shownRef], used: [] });
    expect(await usageOf(shownId)).toEqual({ count: 0, used: false });
  });

  it("counts one record once when the same turn is processed again", async () => {
    // The delivery barrier stops the message going out twice; the counter needs its own guard,
    // because it moves before that barrier is reached.
    const window = {
      conversationId,
      eveSessionId: SESSION,
      turnId: "turn-1",
      turnOrdinal: await memoryShowJournal.openTurn(conversationId, SESSION, "turn-1"),
    };
    await memoryShowJournal.recordShown(window, [shownId]);
    await memoryUsageRepository.recordUsed(window, [shownRef]);

    const again = await memoryUsageRepository.recordUsed(window, [shownRef]);

    expect(again).toEqual({ counted: [], rejected: [], used: [shownRef] });
    expect(await usageOf(shownId)).toEqual({ count: 1, used: true });
  });

  it("refuses a ref whose turn name repeats in a later session", async () => {
    // `turn_0` comes round again after a session rotation; the record it showed then is not this
    // turn's evidence, and the barrier has to tell the two apart.
    const first = {
      conversationId,
      eveSessionId: "wrun_first",
      turnId: "turn_0",
      turnOrdinal: await memoryShowJournal.openTurn(conversationId, "wrun_first", "turn_0"),
    };
    await memoryShowJournal.recordShown(first, [shownId]);
    const rotated = {
      conversationId,
      eveSessionId: "wrun_second",
      turnId: "turn_0",
      turnOrdinal: await memoryShowJournal.openTurn(conversationId, "wrun_second", "turn_0"),
    };

    const outcome = await memoryUsageRepository.recordUsed(rotated, [shownRef]);

    expect(outcome).toEqual({ counted: [], rejected: [shownRef], used: [] });
    expect(await usageOf(shownId)).toEqual({ count: 0, used: false });
  });

  it("leaves reinforcement alone: observing a fact again is not the same as using it", async () => {
    const window = {
      conversationId,
      eveSessionId: SESSION,
      turnId: "turn-1",
      turnOrdinal: await memoryShowJournal.openTurn(conversationId, SESSION, "turn-1"),
    };
    await memoryShowJournal.recordShown(window, [shownId]);
    await memoryUsageRepository.recordUsed(window, [shownRef]);

    const row = await database().query<{ reinforcement_count: number }>(
      "SELECT reinforcement_count FROM memory_items WHERE id = $1",
      [shownId],
    );

    expect(row.rows[0]?.reinforcement_count).toBe(0);
  });

  it("does nothing at all when the model named no records", async () => {
    const window = {
      conversationId,
      eveSessionId: SESSION,
      turnId: "turn-1",
      turnOrdinal: await memoryShowJournal.openTurn(conversationId, SESSION, "turn-1"),
    };

    expect(await memoryUsageRepository.recordUsed(window, []))
      .toEqual({ counted: [], rejected: [], used: [] });
  });
});
