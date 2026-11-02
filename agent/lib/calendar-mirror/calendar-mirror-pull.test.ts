/**
 * Taking a person's edits from Google Calendar.
 *
 * Constructs covered:
 * - The bot's own writes come back as echoes and change nothing; the sync token moves on only when
 *   the whole batch is handled, and an expired token starts a full listing.
 * - Deleting a copy deletes the reminder; the bot's own removal of a paused copy does not.
 * - Moving, renaming and re-repeating a copy edit the reminder; quiet hours never leak into it.
 * - What the bot cannot repeat (several weekdays, all-day, the past, one run of a series) is put
 *   back and the person is told why; Google's own side effects of the bot's writes are ignored.
 * - A person's own event becomes a reminder, or is set aside with a message when it cannot.
 */
import { describe, expect, it, vi } from "vitest";

import { CalendarCallError, type GoogleCalendarEvent } from "../google-workspace/google-calendar-client.js";
import type { MirrorCopyRow, MirrorReminderSource } from "./calendar-mirror-contract.js";
import { fakeCycle, reminderSource } from "./calendar-mirror-fakes.test-support.js";
import { MirrorCalendarRemoved } from "./calendar-mirror-cycle-context.js";
import { mirrorEventId, projectReminderCopy } from "./calendar-mirror-projection.js";
import { pullChanges } from "./calendar-mirror-pull.js";

const REMINDER = reminderSource();
const EVENT_ID = mirrorEventId(REMINDER.id);

/** A copy as the bot last wrote it, and the event Google holds for it. */
function written(source: MirrorReminderSource = REMINDER): { copy: MirrorCopyRow; event: GoogleCalendarEvent } {
  const projected = projectReminderCopy(source, { previous: null });
  if (projected.hidden) throw new Error("expected a shown copy");
  const copy: MirrorCopyRow = {
    etag: "\"ours\"",
    eventId: mirrorEventId(source.id),
    eventUpdated: new Date("2027-02-02T00:00:00Z"),
    fingerprint: projected.fingerprint,
    id: "copy-1",
    kind: "copy",
    pushed: projected.pushed,
    rejectedFingerprint: null,
    reminderId: source.id,
    seriesStartLocal: projected.seriesStartLocal,
    shown: true,
  };
  const event: GoogleCalendarEvent = {
    ...(projected.body as unknown as GoogleCalendarEvent),
    etag: "\"ours\"",
    id: copy.eventId,
    start: { dateTime: `${projected.body.start.dateTime}+03:00`, timeZone: "Europe/Moscow" },
    updated: "2027-02-02T00:00:00Z",
  };
  return { copy, event };
}

function personEdit(event: GoogleCalendarEvent, change: Partial<GoogleCalendarEvent>): GoogleCalendarEvent {
  return { ...event, etag: "\"person\"", updated: "2027-02-03T08:59:00Z", ...change };
}

function cycleWith(items: GoogleCalendarEvent[], options: { copies?: MirrorCopyRow[]; reminders?: MirrorReminderSource[] } = {}) {
  const cycle = fakeCycle({ copies: options.copies ?? [written().copy], reminders: options.reminders ?? [REMINDER] });
  cycle.google.changes.items = items;
  return cycle;
}

describe("pullChanges", () => {
  it("ignores the echo of its own write and moves the sync token on", async () => {
    const cycle = cycleWith([written().event]);
    await pullChanges(cycle.context);
    expect(cycle.writes.applyCalendarEdit).not.toHaveBeenCalled();
    expect(cycle.storage.state.syncToken).toBe("sync-1");
  });

  it("starts a full listing when Google expired the sync token", async () => {
    const cycle = cycleWith([]);
    cycle.google.fail("list", new CalendarCallError("sync_expired", 410, "fullSyncRequired"));
    await pullChanges(cycle.context);
    expect(cycle.google.calls).toEqual([["list", "sync-0"], ["list", "full"]]);
    expect(cycle.storage.state.syncToken).toBe("sync-1");
  });

  it("deletes the reminder whose copy a person deleted", async () => {
    const cycle = cycleWith([{ etag: "\"gone\"", id: EVENT_ID, status: "cancelled" }]);
    await pullChanges(cycle.context);
    expect(cycle.writes.deleteReminderFromCalendar).toHaveBeenCalledWith({
      actorUserId: "user-1",
      copyId: "copy-1",
      familyId: "family-1",
      reminderId: REMINDER.id,
    });
    expect(cycle.context.stats.applied).toBe(1);
  });

  it("keeps a reminder whose copy the bot itself removed", async () => {
    const hidden = { ...written().copy, shown: false };
    const cycle = cycleWith([{ etag: "\"gone\"", id: EVENT_ID, status: "cancelled" }], { copies: [hidden] });
    await pullChanges(cycle.context);
    expect(cycle.writes.deleteReminderFromCalendar).not.toHaveBeenCalled();
  });

  it("deletes no reminder when the calendar itself was deleted, and says so", async () => {
    const second = reminderSource({ content: "Оплатить интернет", id: "6a1f7b63-7064-4a4a-8e9f-1e8b8c3d2f22" });
    const copies = [written().copy, { ...written(second).copy, id: "copy-2" }];
    const cycle = cycleWith(
      copies.map((copy) => ({ etag: "\"gone\"", id: copy.eventId, status: "cancelled" })),
      { copies, reminders: [REMINDER, second] },
    );
    await expect(pullChanges(cycle.context)).rejects.toBeInstanceOf(MirrorCalendarRemoved);
    expect(cycle.writes.deleteReminderFromCalendar).not.toHaveBeenCalled();
    expect([...cycle.storage.copies.values()].every((copy) => !copy.shown)).toBe(true);
    expect(cycle.storage.state.syncToken).toBe("sync-0");
  });

  it("deletes the one reminder a person deleted among several", async () => {
    const second = reminderSource({ content: "Оплатить интернет", id: "6a1f7b63-7064-4a4a-8e9f-1e8b8c3d2f22" });
    const third = reminderSource({ content: "Купить хлеб", id: "7b2f8c74-8175-4b5b-9fa0-2f9c9d4e3033" });
    const copies = [written().copy, { ...written(second).copy, id: "copy-2" }, { ...written(third).copy, id: "copy-3" }];
    const cycle = cycleWith([{ etag: "\"gone\"", id: EVENT_ID, status: "cancelled" }], { copies, reminders: [REMINDER, second, third] });
    await pullChanges(cycle.context);
    expect(cycle.writes.deleteReminderFromCalendar).toHaveBeenCalledTimes(1);
  });

  it("keeps a paused reminder whose copy the bot removed but did not get to record", async () => {
    const cycle = cycleWith(
      [{ etag: "\"gone\"", id: EVENT_ID, status: "cancelled" }],
      { reminders: [reminderSource({ status: "paused" })] },
    );
    await pullChanges(cycle.context);
    expect(cycle.writes.deleteReminderFromCalendar).not.toHaveBeenCalled();
    expect(cycle.storage.copies.get("copy-1")).toMatchObject({ shown: false });
  });

  it("keeps the sync token while a reminder is being delivered", async () => {
    const cycle = cycleWith([{ etag: "\"gone\"", id: EVENT_ID, status: "cancelled" }]);
    cycle.writes.deleteReminderFromCalendar.mockResolvedValueOnce("busy");
    await pullChanges(cycle.context);
    expect(cycle.storage.state.syncToken).toBe("sync-0");
  });

  it("moves the reminder a person moved in the calendar", async () => {
    const { event } = written();
    const cycle = cycleWith([personEdit(event, { start: { dateTime: "2027-02-06T12:00:00+03:00", timeZone: "Europe/Moscow" } })]);
    await pullChanges(cycle.context);
    expect(cycle.writes.applyCalendarEdit).toHaveBeenCalledWith(expect.objectContaining({
      copyId: "copy-1",
      edit: { schedule: { recurrence: null, startLocal: "2027-02-06T12:00:00" } },
      etag: "\"person\"",
      reminderId: REMINDER.id,
    }));
  });

  it("renames the reminder's first line", async () => {
    const source = reminderSource({ content: "Позвонить в банк\nНомер в заметках" });
    const { copy, event } = written(source);
    const cycle = cycleWith([personEdit(event, { summary: "Позвонить в банк до обеда" })], { copies: [copy], reminders: [source] });
    await pullChanges(cycle.context);
    expect(cycle.writes.applyCalendarEdit).toHaveBeenCalledWith(expect.objectContaining({
      edit: { content: "Позвонить в банк до обеда\nНомер в заметках" },
    }));
  });

  it("only remembers the version of an edit that changes nothing it follows", async () => {
    const { event } = written();
    const cycle = cycleWith([personEdit(event, { description: "заметка человека" })]);
    await pullChanges(cycle.context);
    expect(cycle.writes.applyCalendarEdit).not.toHaveBeenCalled();
    expect(cycle.storage.copies.get("copy-1")!.etag).toBe("\"person\"");
  });

  it("changes the repeat from the unshifted start when quiet hours moved the copy", async () => {
    const source = reminderSource({
      anchorLocal: "2027-02-05T07:00:00",
      dueLocal: "2027-02-05T07:00:00",
      quiet: { end: "08:00:00", start: "23:00:00" },
    });
    const { copy, event } = written(source);
    const cycle = cycleWith([personEdit(event, { recurrence: ["RRULE:FREQ=DAILY"] })], { copies: [copy], reminders: [source] });
    await pullChanges(cycle.context);
    expect(cycle.writes.applyCalendarEdit).toHaveBeenCalledWith(expect.objectContaining({
      edit: {
        schedule: {
          recurrence: { anchorDay: 5, anchorMonth: 2, kind: "supported", recurrence: { interval: 1, unit: "daily" } },
          startLocal: "2027-02-05T07:00:00",
        },
      },
    }));
  });

  it.each([
    ["recurrence", { recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU,TH"] }],
    ["all_day", { end: { date: "2027-02-06" }, start: { date: "2027-02-05" } }],
  ])("puts back an edit it cannot follow (%s) and tells why", async (reason, change) => {
    const { event } = written();
    const cycle = cycleWith([personEdit(event, change as Partial<GoogleCalendarEvent>)]);
    cycle.google.events.set(EVENT_ID, event);
    await pullChanges(cycle.context);
    expect(cycle.writes.applyCalendarEdit).not.toHaveBeenCalled();
    expect(cycle.google.calls).toContainEqual(["update", EVENT_ID]);
    expect(cycle.notices).toEqual([{ kind: "edit_unsupported", reason, title: "Позвонить в банк" }]);
    expect(cycle.context.stats.reverted).toBe(1);
  });

  it("puts back a one-time copy moved into the past", async () => {
    const { event } = written();
    const cycle = cycleWith([personEdit(event, { start: { dateTime: "2027-02-01T10:00:00+03:00", timeZone: "Europe/Moscow" } })]);
    cycle.google.events.set(EVENT_ID, event);
    cycle.writes.applyCalendarEdit.mockResolvedValueOnce({ unsupported: "past" });
    await pullChanges(cycle.context);
    expect(cycle.google.calls).toContainEqual(["update", EVENT_ID]);
    expect(cycle.notices).toEqual([{ kind: "edit_unsupported", reason: "past", title: "Позвонить в банк" }]);
  });

  it("leaves an edit to the bot when the reminder changed later than the event", async () => {
    const { copy, event } = written();
    const newer = reminderSource({ content: "Новый текст", updatedAt: new Date("2027-02-03T08:59:30Z") });
    const cycle = cycleWith([personEdit(event, { summary: "Своё название" })], { copies: [copy], reminders: [newer] });
    await pullChanges(cycle.context);
    expect(cycle.writes.applyCalendarEdit).not.toHaveBeenCalled();
  });

  it("puts back one moved run of a series and tells why", async () => {
    const series = reminderSource({ recurrence: { interval: 1, unit: "weekly" } });
    const { copy } = written(series);
    const instance: GoogleCalendarEvent = {
      etag: "\"instance\"",
      id: `${EVENT_ID}_20270212T070000Z`,
      originalStartTime: { dateTime: "2027-02-12T10:00:00+03:00", timeZone: "Europe/Moscow" },
      recurringEventId: EVENT_ID,
      start: { dateTime: "2027-02-12T12:00:00+03:00", timeZone: "Europe/Moscow" },
      status: "confirmed",
      summary: copy.pushed!.summary,
    };
    const cycle = cycleWith([instance], { copies: [copy], reminders: [series] });
    await pullChanges(cycle.context);
    expect(cycle.google.calls).toEqual([["list", "sync-0"], ["patch", instance.id]]);
    expect(cycle.google.events.get(instance.id)).toMatchObject({
      end: { dateTime: "2027-02-12T07:15:00.000Z", timeZone: "Europe/Moscow" },
      start: { dateTime: "2027-02-12T10:00:00+03:00", timeZone: "Europe/Moscow" },
      status: "confirmed",
    });
    expect(cycle.notices).toEqual([{ kind: "edit_unsupported", reason: "instance", title: "Позвонить в банк" }]);
  });

  it("ignores runs Google itself cancelled after the bot rewrote a series", async () => {
    const series = reminderSource({ recurrence: { interval: 1, unit: "weekly" } });
    const { copy, event } = written(series);
    const cycle = cycleWith(
      [event, { id: `${EVENT_ID}_20270212T070000Z`, status: "cancelled" }],
      { copies: [copy], reminders: [series] },
    );
    await pullChanges(cycle.context);
    expect(cycle.google.calls).toEqual([["list", "sync-0"]]);
    expect(cycle.notices).toEqual([]);
  });

  it("makes a person's own event a reminder", async () => {
    const cycle = cycleWith([{
      etag: "\"own\"",
      id: "personevent01",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH"],
      start: { dateTime: "2027-02-04T18:00:00+03:00", timeZone: "Europe/Moscow" },
      status: "confirmed",
      summary: "Купить хлеб",
      updated: "2027-02-03T08:00:00Z",
    }]);
    await pullChanges(cycle.context);
    expect(cycle.writes.createReminderFromEvent).toHaveBeenCalledWith(expect.objectContaining({
      content: "Купить хлеб",
      etag: "\"own\"",
      eventId: "personevent01",
      recurrence: { anchorDay: 4, anchorMonth: 2, kind: "supported", recurrence: { interval: 1, unit: "weekly" } },
      start: { instant: new Date("2027-02-04T15:00:00Z") },
    }));
    expect(cycle.context.stats.created).toBe(1);
  });

  it("takes an all-day event at its date", async () => {
    const cycle = cycleWith([{ end: { date: "2027-03-11" }, etag: "\"own\"", id: "allday0001", start: { date: "2027-03-10" }, status: "confirmed", summary: "ДР" }]);
    await pullChanges(cycle.context);
    expect(cycle.writes.createReminderFromEvent).toHaveBeenCalledWith(expect.objectContaining({ start: { allDayDate: "2027-03-10" } }));
  });

  it.each([
    ["event_unsupported", ["RRULE:FREQ=MONTHLY;BYDAY=3TU"], undefined, { kind: "event_unsupported", title: "Йога" }],
    ["settings_missing", undefined, "settings_missing" as const, { kind: "settings_missing" }],
  ])("sets aside an own event it cannot take (%s) and tells once", async (_case, recurrence, result, notice) => {
    const own: GoogleCalendarEvent = {
      etag: "\"own\"",
      id: "personevent02",
      ...(recurrence ? { recurrence } : {}),
      start: { dateTime: "2027-02-16T18:00:00+03:00", timeZone: "Europe/Moscow" },
      status: "confirmed",
      summary: "Йога",
    };
    const cycle = cycleWith([own]);
    if (result) cycle.writes.createReminderFromEvent.mockResolvedValueOnce(result);
    await pullChanges(cycle.context);
    expect(cycle.notices).toEqual([notice]);
    expect([...cycle.storage.copies.values()].find((copy) => copy.eventId === "personevent02"))
      .toMatchObject({ etag: "\"own\"", kind: "ignored" });

    cycle.notices.length = 0;
    cycle.writes.createReminderFromEvent.mockClear();
    await pullChanges(cycle.context);
    expect(cycle.notices).toEqual([]);
    expect(cycle.writes.createReminderFromEvent).not.toHaveBeenCalled();
  });

  describe("a series split in Google («this and following»)", () => {
    const series = reminderSource({ recurrence: { interval: 1, unit: "weekly" } });
    function splitBatch(marked: boolean) {
      const { copy, event } = written(series);
      const original = personEdit(event, { recurrence: ["RRULE:FREQ=WEEKLY;INTERVAL=1;UNTIL=20270218T205959Z"] });
      const continuation: GoogleCalendarEvent = {
        etag: "\"continuation\"",
        ...(marked ? { extendedProperties: event.extendedProperties } : {}),
        id: "splitcontinuation01",
        recurrence: ["RRULE:FREQ=WEEKLY;INTERVAL=1"],
        start: { dateTime: "2027-02-19T12:00:00+03:00", timeZone: "Europe/Moscow" },
        status: "confirmed",
        summary: event.summary,
        updated: "2027-02-03T08:59:00Z",
      };
      return { continuation, copy, original };
    }

    it.each([
      ["with the copy's marks, original first", true, false],
      ["with the copy's marks, continuation first", true, true],
      ["with only the title, original first", false, false],
      ["with only the title, continuation first", false, true],
    ])("follows the continuing series %s", async (_case, marked, continuationFirst) => {
      const { continuation, copy, original } = splitBatch(marked);
      const cycle = cycleWith(continuationFirst ? [continuation, original] : [original, continuation], { copies: [copy], reminders: [series] });
      await pullChanges(cycle.context);
      expect(cycle.writes.applyCalendarEdit).toHaveBeenCalledTimes(1);
      expect(cycle.writes.applyCalendarEdit).toHaveBeenCalledWith(expect.objectContaining({
        edit: {
          schedule: {
            recurrence: { anchorDay: 19, anchorMonth: 2, kind: "supported", recurrence: { interval: 1, unit: "weekly" } },
            startLocal: "2027-02-19T12:00:00",
          },
        },
      }));
      expect(cycle.storage.copies.get("copy-1")!.eventId).toBe("splitcontinuation01");
      expect(cycle.google.calls).toContainEqual(["delete", EVENT_ID]);
      expect(cycle.writes.createReminderFromEvent).not.toHaveBeenCalled();
      expect(cycle.notices).toEqual([]);
    });

    it("puts back a series a person only ended, with no continuation", async () => {
      const { copy, original } = splitBatch(true);
      const cycle = cycleWith([original], { copies: [copy], reminders: [series] });
      cycle.google.events.set(EVENT_ID, original);
      await pullChanges(cycle.context);
      expect(cycle.writes.applyCalendarEdit).not.toHaveBeenCalled();
      expect(cycle.notices).toEqual([{ kind: "edit_unsupported", reason: "recurrence", title: "Позвонить в банк" }]);
    });
  });

  it("takes the bot's own write whose answer was lost as its own", async () => {
    const { copy, event } = written();
    const changed = reminderSource({ content: "Позвонить в банк до обеда", updatedAt: new Date("2027-02-03T08:58:00Z") });
    const landed = written(changed).event;
    const cycle = cycleWith([{ ...landed, etag: "\"landed\"", updated: "2027-02-03T08:59:00Z" }], { copies: [copy], reminders: [changed] });
    expect(event.summary).not.toBe(landed.summary);
    await pullChanges(cycle.context);
    expect(cycle.writes.applyCalendarEdit).not.toHaveBeenCalled();
    expect(cycle.storage.copies.get("copy-1")).toMatchObject({ etag: "\"landed\"", pushed: expect.objectContaining({ summary: "🔔 Позвонить в банк до обеда" }) });
  });

  it("does not take a removed bell for a new name", async () => {
    const { event } = written();
    const cycle = cycleWith([personEdit(event, { summary: "Позвонить в банк" })]);
    await pullChanges(cycle.context);
    expect(cycle.writes.applyCalendarEdit).not.toHaveBeenCalled();
  });

  it("keeps the calendar going when Google refuses to put one run back", async () => {
    const series = reminderSource({ recurrence: { interval: 1, unit: "weekly" } });
    const { copy } = written(series);
    const instance: GoogleCalendarEvent = {
      etag: "\"instance\"",
      id: `${EVENT_ID}_20270212T070000Z`,
      originalStartTime: { dateTime: "2027-02-12T10:00:00+03:00", timeZone: "Europe/Moscow" },
      recurringEventId: EVENT_ID,
      status: "cancelled",
    };
    const cycle = cycleWith([instance], { copies: [copy], reminders: [series] });
    cycle.google.fail("patch", new CalendarCallError("rejected", 403, "forbidden"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await pullChanges(cycle.context);
    error.mockRestore();
    expect(cycle.storage.state.syncToken).toBe("sync-1");
  });

  it("makes a copy brought back from Google's bin a reminder without the bot's footer", async () => {
    const { event } = written(reminderSource({ content: "Позвонить в банк\nНомер в заметках" }));
    const cycle = cycleWith([{ ...event, etag: "\"restored\"", id: "restoredcopy01" }], { copies: [], reminders: [] });
    await pullChanges(cycle.context);
    expect(cycle.writes.createReminderFromEvent).toHaveBeenCalledWith(expect.objectContaining({
      content: "Позвонить в банк\n\nНомер в заметках",
    }));
  });

  it("sets aside an event without a title or notes", async () => {
    const cycle = cycleWith([{ etag: "\"empty\"", id: "emptyevent01", start: { dateTime: "2027-02-16T18:00:00+03:00" }, status: "confirmed" }]);
    await pullChanges(cycle.context);
    expect(cycle.writes.createReminderFromEvent).not.toHaveBeenCalled();
    expect(cycle.notices).toEqual([]);
    expect([...cycle.storage.copies.values()].find((copy) => copy.eventId === "emptyevent01")).toMatchObject({ kind: "ignored" });
  });
});
