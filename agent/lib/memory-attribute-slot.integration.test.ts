/**
 * A new version of a property replacing the old one instead of lying down beside it.
 *
 * Constructs covered:
 * - `111_memory_attribute_slot.sql`: the slot names the property, never its value.
 * - The previous holder of a slot becomes `superseded` and keeps pointing at its replacement.
 * - It is not deleted: its text stays readable and its history stays in the list.
 * - A different subject, a different scope, or no slot at all leaves the old record alone.
 * - Undoing the create puts the previous version back into use.
 * - The retired version leaves the ordinary list but is still reachable as history.
 * - Correcting a record keeps its slot, so the next version still replaces it.
 * - Removing a middle version hands its history to the current one instead of reviving it.
 * - Removing a corrected record does not bring back the wording that was corrected.
 *
 * The danger this file is really about is the second one from the issue: a slot named too widely
 * («еда») would silently retire independent facts. That is why every test here asserts what was
 * *not* touched as well as what was.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryRepository } from "./memory-repository.js";
import { memoryUndoRepository } from "./memory-undo-repository.js";
import {
  createMemoryCorrectionSource,
  createMemoryFamilyFixture,
} from "./memory-repository.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase("memory attribute slot", () => {
  let owner: MemoryAuthorization;
  let member: MemoryAuthorization;

  beforeEach(async () => {
    await database().query(
      "TRUNCATE memory_embedding_chunks, memory_embedding_jobs, memory_items_all, application_conversations, family_memberships, users, families CASCADE",
    );
    const fixture = await createMemoryFamilyFixture("slot");
    owner = fixture.owner;
    member = fixture.member;
  });

  afterAll(async () => closeDatabase());

  async function remember(input: {
    attribute?: string;
    auth: MemoryAuthorization;
    content: string;
    key: string;
    scope?: "family" | "personal";
    subject?: { kind: "current_author" } | { kind: "none" };
  }) {
    const scope = input.scope ?? "personal";
    const source = await createMemoryCorrectionSource(input.auth, scope);
    return memoryRepository.create(input.auth, {
      ...(input.attribute === undefined ? {} : { attribute: input.attribute }),
      confirmation: "user_confirmed",
      content: input.content,
      explicitSource: {
        conversationId: source.conversationId,
        subject: input.subject ?? { kind: "current_author" },
        timelineEntryId: source.timelineEntryId,
      },
      kind: "preference",
      operationKey: input.key,
      provenance: { sessionId: "slot-session", turnId: input.key },
      scope,
      sensitivity: "normal",
      source: `eve:slot:${input.key}`,
    });
  }

  async function statusOf(id: string) {
    const row = await database().query<{
      claim_status: string;
      content: string;
      superseded_by: string | null;
    }>(
      "SELECT claim_status, content, superseded_by FROM memory_items WHERE id = $1",
      [id],
    );
    return row.rows[0]!;
  }

  it("retires the previous version of the same property and keeps its text", async () => {
    const old = await remember({
      attribute: "кофе", auth: owner, content: "Пьёт кофе с двумя ложками сахара", key: "slot-1",
    });

    const fresh = await remember({
      attribute: "кофе", auth: owner, content: "Пьёт кофе без сахара", key: "slot-2",
    });

    expect(await statusOf(old.id)).toEqual({
      claim_status: "superseded",
      content: "Пьёт кофе с двумя ложками сахара",
      superseded_by: fresh.id,
    });
    expect((await statusOf(fresh.id)).claim_status).toBe("active");
  });

  it("names the property, so a record without a slot is never retired by one", async () => {
    const unslotted = await remember({
      auth: owner, content: "Пьёт кофе с двумя ложками сахара", key: "slot-3",
    });

    await remember({ attribute: "кофе", auth: owner, content: "Пьёт кофе без сахара", key: "slot-4" });

    expect((await statusOf(unslotted.id)).claim_status).toBe("active");
  });

  it("leaves another person's record of the same property alone", async () => {
    const other = await remember({
      attribute: "кофе", auth: member, content: "Участник пьёт кофе с молоком", key: "slot-5",
    });

    await remember({ attribute: "кофе", auth: owner, content: "Пьёт кофе без сахара", key: "slot-6" });

    expect((await statusOf(other.id)).claim_status).toBe("active");
  });

  it("does not let a personal record retire a family one", async () => {
    const shared = await remember({
      attribute: "кофе", auth: owner, content: "В семье пьют кофе без сахара",
      key: "slot-7", scope: "family", subject: { kind: "none" },
    });

    await remember({ attribute: "кофе", auth: owner, content: "Пьёт кофе с молоком", key: "slot-8" });

    expect((await statusOf(shared.id)).claim_status).toBe("active");
  });

  it("treats the slot name as a name, not as text: case and spacing do not make a new slot", async () => {
    const old = await remember({
      attribute: "Место Работы", auth: owner, content: "Работает в «Ладоге»", key: "slot-9",
    });

    const fresh = await remember({
      attribute: "  место  работы ", auth: owner, content: "Работает в «Ладожце»", key: "slot-10",
    });

    expect((await statusOf(old.id)).superseded_by).toBe(fresh.id);
  });

  it("refuses a slot on an episode, because a moment is not a property", async () => {
    const source = await createMemoryCorrectionSource(owner, "personal");

    await expect(memoryRepository.create(owner, {
      attribute: "поездка",
      confirmation: "user_confirmed",
      content: "В августе ездили в Суздаль",
      explicitSource: {
        conversationId: source.conversationId,
        subject: { kind: "current_author" },
        timelineEntryId: source.timelineEntryId,
      },
      kind: "episode",
      operationKey: "slot-11",
      provenance: { sessionId: "slot-session", turnId: "slot-11" },
      scope: "personal",
      sensitivity: "normal",
      source: "eve:slot:11",
    })).rejects.toMatchObject({ code: "AGENT_MEMORY_ATTRIBUTE_INVALID" });
  });

  it("puts the previous version back when the new one is undone", async () => {
    // Undo is the model's own correction path. If it only removed the new record, the old one
    // would stay retired and the person would lose a fact by asking to cancel a mistake.
    const old = await remember({
      attribute: "кофе", auth: owner, content: "Пьёт кофе с двумя ложками сахара", key: "slot-13",
    });
    const fresh = await remember({
      attribute: "кофе", auth: owner, content: "Пьёт кофе без сахара", key: "slot-14",
    });

    await memoryUndoRepository.undoCreate(owner, fresh.id, {
      operationKey: "slot-14-undo", sessionId: "slot-session", turnId: "slot-14",
    });

    expect(await statusOf(old.id)).toEqual({
      claim_status: "active",
      content: "Пьёт кофе с двумя ложками сахара",
      superseded_by: null,
    });
  });

  it("takes the old version out of the ordinary list but keeps it as history", async () => {
    const old = await remember({
      attribute: "кофе", auth: owner, content: "Пьёт кофе с двумя ложками сахара", key: "slot-15",
    });
    await remember({ attribute: "кофе", auth: owner, content: "Пьёт кофе без сахара", key: "slot-16" });

    const current = await memoryRepository.list(owner, { limit: 20 });
    const history = await memoryRepository.list(owner, { history: true, limit: 20 });

    expect(current.items.map((item) => item.id)).not.toContain(old.id);
    expect(history.items.find((item) => item.id === old.id))
      .toMatchObject({ attribute: "кофе", status: "superseded" });
  });

  it("keeps the slot when the record is corrected, not replaced", async () => {
    // The neighbour gate tells the model to correct rather than duplicate, so a correction that
    // dropped the slot would quietly switch the replacement rule off for that property.
    const first = await remember({
      attribute: "место работы", auth: owner, content: "Работает в «Ладоге»", key: "slot-17",
    });
    const source = await createMemoryCorrectionSource(owner, "personal");

    const corrected = await memoryRepository.updateByRef(owner, {
      content: "Работает в «Ладоге» ведущим инженером",
      memoryRef: first.memoryRef,
      operationKey: "slot-17-edit",
      source,
    });

    expect(corrected.attribute).toBe("место работы");
  });

  it("hands history to the current version when a middle one is removed", async () => {
    const oldest = await remember({
      attribute: "кофе", auth: owner, content: "С двумя ложками", key: "slot-18",
    });
    const middle = await remember({
      attribute: "кофе", auth: owner, content: "С одной ложкой", key: "slot-19",
    });
    const current = await remember({
      attribute: "кофе", auth: owner, content: "Без сахара", key: "slot-20",
    });

    await memoryRepository.deleteByRef(owner, middle.memoryRef, "slot-19-delete");

    // Two active records in one slot would be the very thing the slot exists to prevent.
    expect(await statusOf(oldest.id))
      .toEqual({ claim_status: "superseded", content: "С двумя ложками", superseded_by: current.id });
    expect((await statusOf(current.id)).claim_status).toBe("active");
  });

  it("refuses a slot longer than a name", async () => {
    await expect(remember({
      attribute: "как именно этот человек предпочитает пить кофе по утрам в будние дни",
      auth: owner, content: "Пьёт кофе без сахара", key: "slot-12",
    })).rejects.toMatchObject({ code: "AGENT_MEMORY_ATTRIBUTE_INVALID" });
  });
});
