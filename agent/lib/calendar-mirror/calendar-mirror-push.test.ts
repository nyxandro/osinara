/**
 * Writing reminder copies to Google Calendar.
 *
 * Constructs covered:
 * - A new reminder gets its own event under the reminder's id; an unchanged one costs no call.
 * - A changed reminder replaces the event; a vanished event is inserted again under the same id, and
 *   an event left by an interrupted attempt is replaced instead of duplicated.
 * - A paused reminder's event is removed and comes back on resume; a deleted reminder's event goes.
 * - An event Google refuses is not retried until the reminder changes; a deferred cycle stops.
 */
import { describe, expect, it } from "vitest";

import { CalendarCallError } from "../google-workspace/google-calendar-client.js";
import { MirrorCycleDeferred } from "./calendar-mirror-cycle-context.js";
import { blankCopy, fakeCycle, reminderSource } from "./calendar-mirror-fakes.test-support.js";
import { HIDDEN_COPY_FINGERPRINT, HIDING_COPY_FINGERPRINT, mirrorEventId } from "./calendar-mirror-projection.js";
import { pushCopies } from "./calendar-mirror-push.js";

const EVENT_ID = mirrorEventId(reminderSource().id);

describe("pushCopies", () => {
  it("creates an event for a new reminder and records it", async () => {
    const cycle = fakeCycle({ reminders: [reminderSource()] });
    await pushCopies(cycle.context);
    expect(cycle.google.calls).toEqual([["insert", EVENT_ID]]);
    const [copy] = cycle.storage.copies.values();
    expect(copy).toMatchObject({
      etag: cycle.google.events.get(EVENT_ID)!.etag,
      eventId: EVENT_ID,
      reminderId: reminderSource().id,
      shown: true,
    });
    expect(copy!.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(cycle.google.events.get(EVENT_ID)).toMatchObject({ summary: "🔔 Позвонить в банк", transparency: "transparent" });
    expect(cycle.context.stats.written).toBe(1);
  });

  it("makes no call for an unchanged reminder and replaces the event of a changed one", async () => {
    const cycle = fakeCycle({ reminders: [reminderSource()] });
    await pushCopies(cycle.context);
    cycle.google.calls.length = 0;
    await pushCopies(cycle.context);
    expect(cycle.google.calls).toEqual([]);

    cycle.storage.reminders[0] = reminderSource({ content: "Позвонить в банк до обеда" });
    await pushCopies(cycle.context);
    expect(cycle.google.calls).toEqual([["update", EVENT_ID]]);
    expect(cycle.google.events.get(EVENT_ID)!.summary).toBe("🔔 Позвонить в банк до обеда");
  });

  it("removes the event of a paused reminder and brings it back on resume", async () => {
    const cycle = fakeCycle({ reminders: [reminderSource()] });
    await pushCopies(cycle.context);
    cycle.storage.reminders[0] = reminderSource({ status: "paused" });
    cycle.google.calls.length = 0;
    await pushCopies(cycle.context);
    expect(cycle.google.calls).toEqual([["delete", EVENT_ID]]);
    expect([...cycle.storage.copies.values()][0]).toMatchObject({ fingerprint: HIDDEN_COPY_FINGERPRINT, shown: false });

    cycle.storage.reminders[0] = reminderSource();
    cycle.google.calls.length = 0;
    await pushCopies(cycle.context);
    expect(cycle.google.calls).toEqual([["update", EVENT_ID]]);
    expect(cycle.google.events.get(EVENT_ID)!.status).toBe("confirmed");
    expect([...cycle.storage.copies.values()][0]!.shown).toBe(true);
  });

  it("removes again an event whose removal was cut off", async () => {
    const hiding = { ...blankCopy("copy-hiding", EVENT_ID), fingerprint: HIDING_COPY_FINGERPRINT, reminderId: reminderSource().id };
    const cycle = fakeCycle({ copies: [hiding], reminders: [reminderSource({ status: "paused" })] });
    await pushCopies(cycle.context);
    expect(cycle.google.calls).toEqual([["delete", EVENT_ID]]);
    expect(cycle.storage.copies.get("copy-hiding")).toMatchObject({ fingerprint: HIDDEN_COPY_FINGERPRINT, shown: false });
  });

  it("removes the event of a deleted reminder together with its copy", async () => {
    const orphan = { ...blankCopy("copy-orphan", "osrgone"), fingerprint: "a".repeat(64), shown: true };
    const cycle = fakeCycle({ copies: [orphan] });
    await pushCopies(cycle.context);
    expect(cycle.google.calls).toEqual([["delete", "osrgone"]]);
    expect(cycle.storage.copies.size).toBe(0);
    expect(cycle.context.stats.deleted).toBe(1);
  });

  it("does not retry an event Google refused until the reminder changes", async () => {
    const cycle = fakeCycle({ reminders: [reminderSource()] });
    cycle.google.fail("insert", new CalendarCallError("rejected", 400, "invalid"));
    await pushCopies(cycle.context);
    expect(cycle.context.stats.rejected).toBe(1);
    const [copy] = cycle.storage.copies.values();
    expect(copy!.rejectedFingerprint).toMatch(/^[0-9a-f]{64}$/u);

    cycle.google.calls.length = 0;
    await pushCopies(cycle.context);
    expect(cycle.google.calls).toEqual([]);

    cycle.storage.reminders[0] = reminderSource({ content: "Новый текст" });
    await pushCopies(cycle.context);
    expect(cycle.google.calls).toEqual([["insert", EVENT_ID]]);
  });

  it("replaces an event left by an interrupted attempt instead of inserting a second one", async () => {
    const cycle = fakeCycle({ reminders: [reminderSource()] });
    cycle.google.events.set(EVENT_ID, { etag: "\"old\"", id: EVENT_ID, status: "cancelled" });
    await pushCopies(cycle.context);
    expect(cycle.google.calls).toEqual([["insert", EVENT_ID], ["update", EVENT_ID]]);
    expect(cycle.google.events.get(EVENT_ID)!.status).toBe("confirmed");
  });

  it("inserts again an event that vanished from Google", async () => {
    const cycle = fakeCycle({ reminders: [reminderSource()] });
    await pushCopies(cycle.context);
    cycle.google.events.clear();
    cycle.storage.reminders[0] = reminderSource({ content: "Новый текст" });
    cycle.google.calls.length = 0;
    await pushCopies(cycle.context);
    expect(cycle.google.calls).toEqual([["update", EVENT_ID], ["insert", EVENT_ID]]);
  });

  it("stops at a deferred call and keeps what was written", async () => {
    const cycle = fakeCycle({ reminders: [reminderSource()] });
    cycle.google.fail("insert", new MirrorCycleDeferred("budget") as unknown as CalendarCallError);
    await expect(pushCopies(cycle.context)).rejects.toBeInstanceOf(MirrorCycleDeferred);
  });
});
