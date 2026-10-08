/**
 * What production's automatic selection showed in a turn, and what that turn itself used.
 *
 * Constructs covered:
 * - `loadShowJournal` keeps only the selection's shows: a search, a listing or the standing profile
 *   is not what the selection offered (#339).
 * - A show counts as used by its turn only when that turn used it, not a later turn of the session.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../../../agent/lib/database.js";
import { memoryShowJournal } from "../../../agent/lib/memory-show-journal.js";
import { loadShowJournal } from "./candidate-pool.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = enabled ? describe : describe.skip;

const SESSION = "wrun_golden_journal";

describeWithDatabase("loadShowJournal", () => {
  let conversationId: string;
  const refs: Record<string, string> = {};
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    await database().query(
      "TRUNCATE memory_items_all, application_conversations, family_memberships, users, families CASCADE",
    );
    const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Эталон') RETURNING id");
    const user = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('golden-owner', 'Владелец') RETURNING id",
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [family.rows[0]!.id, user.rows[0]!.id],
    );
    // The personal conversation is created by a trigger on membership.
    conversationId = (await database().query<{ id: string }>(
      "SELECT id FROM application_conversations WHERE family_id = $1 AND owner_user_id = $2",
      [family.rows[0]!.id, user.rows[0]!.id],
    )).rows[0]!.id;
    for (const key of ["selected", "selectedUsedLater", "searched", "profile"]) {
      const inserted = await database().query<{ id: string }>(
        `INSERT INTO memory_items
           (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
            content, source, confirmation, sensitivity, operation_key)
         VALUES ($1, $2, $2, 'golden-owner', 'personal', 'fact', $3, 'test:golden', 'user_confirmed', 'normal', $4)
         RETURNING id`,
        [family.rows[0]!.id, user.rows[0]!.id, `Запись ${key}`, `golden-journal-${key}`],
      );
      ids[key] = inserted.rows[0]!.id;
      refs[key] = (await database().query<{ memory_ref: string }>(
        "SELECT memory_ref FROM memory_item_refs WHERE memory_item_id = $1", [ids[key]],
      )).rows[0]!.memory_ref;
    }
  });

  afterAll(closeDatabase);

  it("reads only what the selection showed, used by the turn that showed it", async () => {
    const turnOrdinal = await memoryShowJournal.openTurn(conversationId, SESSION, "turn_1");
    await memoryShowJournal.openTurn(conversationId, SESSION, "turn_2");
    const window = { agentSessionId: SESSION, conversationId, turnId: "turn_1", turnOrdinal };
    await memoryShowJournal.recordShown(window, [ids.selected!, ids.selectedUsedLater!]);
    await memoryShowJournal.recordShownRefs(window, [refs.searched!], "search");
    await memoryShowJournal.recordShownRefs(window, [refs.profile!], "profile");
    await database().query(
      `UPDATE memory_retrieval_shows SET used_at = now(), used_turn_id = CASE claim_id
         WHEN $1::uuid THEN 'turn_1' ELSE 'turn_2' END
       WHERE conversation_id = $2 AND claim_id = ANY($3::uuid[])`,
      [ids.selected, conversationId, [ids.selected, ids.selectedUsedLater, ids.searched]],
    );

    const turn = (await loadShowJournal()).get(`${SESSION}\u0000turn_1`);

    expect(turn?.shown.sort()).toEqual([refs.selected, refs.selectedUsedLater].sort());
    expect(turn?.used).toEqual([refs.selected]);
  });
});
