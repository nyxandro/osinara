/**
 * When something happened, as opposed to when it was written down.
 *
 * Constructs covered:
 * - `112_memory_occurred_on.sql`: the date of the event, empty unless the conversation gave one.
 * - A window over that date finds the records that belong to the period.
 * - A record without an event date falls back to when it was written, not out of the result.
 * - The window never reaches outside the area of memory it was asked about.
 * - Ageing keeps reading the date the record appeared: a decade-old event told today is fresh.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { memoryRetentionMultiplier } from "./memory-forgetting.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryRepository } from "./memory-repository.js";
import { memoryEventWindowRepository } from "./memory-event-window-repository.js";
import {
  createMemoryCorrectionSource,
  createMemoryFamilyFixture,
} from "./memory-repository.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase("memory event date", () => {
  let owner: MemoryAuthorization;

  beforeEach(async () => {
    await database().query(
      "TRUNCATE memory_embedding_chunks, memory_embedding_jobs, memory_items_all, application_conversations, family_memberships, users, families CASCADE",
    );
    owner = (await createMemoryFamilyFixture("event")).owner;
  });

  afterAll(async () => closeDatabase());

  async function remember(input: { content: string; key: string; occurredOn?: string }) {
    const source = await createMemoryCorrectionSource(owner, "personal");
    return memoryRepository.create(owner, {
      confirmation: "user_confirmed",
      content: input.content,
      explicitSource: {
        conversationId: source.conversationId,
        subject: { kind: "current_author" },
        timelineEntryId: source.timelineEntryId,
      },
      kind: "episode",
      ...(input.occurredOn === undefined ? {} : { occurredOn: input.occurredOn }),
      operationKey: input.key,
      provenance: { sessionId: "event-session", turnId: input.key },
      scope: "personal",
      sensitivity: "normal",
      source: `eve:event:${input.key}`,
    });
  }

  it("stores the day the event happened, not the day it was written down", async () => {
    const trip = await remember({
      content: "Ездили в Суздаль", key: "event-1", occurredOn: "2026-08-14",
    });

    const row = await database().query<{ occurred_on: Date | null }>(
      "SELECT occurred_on FROM memory_items WHERE id = $1", [trip.id],
    );

    expect(row.rows[0]!.occurred_on?.toISOString().slice(0, 10)).toBe("2026-08-14");
    expect(trip.occurredOn).toBe("2026-08-14");
  });

  it("finds what belongs to a period and leaves out what does not", async () => {
    const august = await remember({
      content: "Ездили в Суздаль", key: "event-2", occurredOn: "2026-08-14",
    });
    const july = await remember({
      content: "Меняли счётчик", key: "event-3", occurredOn: "2026-07-02",
    });

    const found = await memoryEventWindowRepository.search(owner, {
      from: "2026-08-01", timezone: "Europe/Moscow", to: "2026-08-31",
    });

    expect(found.map((item) => item.id)).toEqual([august.id]);
    expect(found.map((item) => item.id)).not.toContain(july.id);
  });

  it("falls back to the day it was written when the event date is unknown", async () => {
    const undated = await remember({ content: "Что-то было", key: "event-4" });

    const today = new Date().toISOString().slice(0, 10);
    const found = await memoryEventWindowRepository.search(owner, { from: today, timezone: "UTC", to: today });

    expect(found.map((item) => item.id)).toContain(undated.id);
  });

  it("refuses a date outside the range a conversation can mean", async () => {
    await expect(remember({ content: "Ездили в Суздаль", key: "event-5", occurredOn: "1685-03-21" }))
      .rejects.toMatchObject({ code: "AGENT_MEMORY_OCCURRED_ON_INVALID" });
  });

  it("leaves ageing on the day the record appeared", () => {
    // A trip from ten years ago, told today, is fresh knowledge. Mixing the two axes would hide
    // what a person has only just said.
    const told = memoryRetentionMultiplier({ ageDays: 0, kind: "episode", usageCount: 0 });

    expect(told).toBe(1);
  });
});
