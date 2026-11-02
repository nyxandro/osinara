/**
 * Calendar copy of a reminder.
 *
 * Constructs covered:
 * - A copy stands at the moment the message really arrives: quiet hours move it to their end.
 * - Paused, failed and every-few-minutes reminders have no copy.
 * - The title is the first line without markup or files; the full text goes to the description.
 * - A series keeps its start while its anchor stays; a month-end series moved over midnight by
 *   quiet hours falls back to the nearest run.
 * - The fingerprint changes with every shown field and not with the next run of a series.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { MirrorCopyRow, MirrorReminderSource } from "./calendar-mirror-contract.js";
import { CALENDAR_MIRROR_COPY_FOOTER } from "./calendar-mirror-config.js";
import { mirrorEventId, projectReminderCopy } from "./calendar-mirror-projection.js";
import { contentWithTitle, copyTitle } from "./calendar-mirror-text.js";

function reminder(overrides: Partial<MirrorReminderSource> = {}): MirrorReminderSource {
  return {
    anchorLocal: "2027-02-05T10:00:00",
    content: "Позвонить в банк",
    dueLocal: "2027-02-05T10:00:00",
    id: "5f0e6a52-6f53-4f39-9d8e-0d7a7b2c1e11",
    quiet: null,
    recurrence: null,
    status: "active",
    timezone: "Europe/Moscow",
    updatedAt: new Date("2027-01-01T00:00:00Z"),
    ...overrides,
  };
}

function shown(copy: ReturnType<typeof projectReminderCopy>) {
  if (copy.hidden) throw new Error(`expected a shown copy, got ${copy.reason}`);
  return copy;
}

describe("projectReminderCopy", () => {
  it("lays out a one-time reminder as a quiet free event", () => {
    const copy = shown(projectReminderCopy(reminder(), { previous: null }));
    expect(copy.body).toEqual({
      description: `Позвонить в банк\n\n${CALENDAR_MIRROR_COPY_FOOTER}`,
      end: { dateTime: "2027-02-05T10:15:00", timeZone: "Europe/Moscow" },
      extendedProperties: { private: { osinaraMirror: "1", osinaraReminderId: reminder().id } },
      reminders: { overrides: [], useDefault: false },
      start: { dateTime: "2027-02-05T10:00:00", timeZone: "Europe/Moscow" },
      status: "confirmed",
      summary: "🔔 Позвонить в банк",
      transparency: "transparent",
    });
    expect(copy.pushed).toEqual({
      anchorLocal: "2027-02-05T10:00:00",
      recurrence: null,
      sourceRecurrence: null,
      startLocal: "2027-02-05T10:00:00",
      summary: "🔔 Позвонить в банк",
      timeZone: "Europe/Moscow",
    });
    expect(copy.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("names own events by the reminder id", () => {
    expect(mirrorEventId("5f0e6a52-6f53-4f39-9d8e-0d7a7b2c1e11")).toBe("osr5f0e6a526f534f399d8e0d7a7b2c1e11");
  });

  it("moves a copy to the end of the author's quiet hours", () => {
    const quiet = { end: "08:00:00", start: "23:00:00" };
    const morning = shown(projectReminderCopy(
      reminder({ anchorLocal: "2027-02-05T07:00:00", dueLocal: "2027-02-05T07:00:00", quiet }),
      { previous: null },
    ));
    expect(morning.body.start.dateTime).toBe("2027-02-05T08:00:00");
    const night = shown(projectReminderCopy(
      reminder({ anchorLocal: "2027-02-05T23:30:00", dueLocal: "2027-02-05T23:30:00", quiet }),
      { previous: null },
    ));
    expect(night.body.start.dateTime).toBe("2027-02-06T08:00:00");
    const day = shown(projectReminderCopy(
      reminder({ quiet: { end: "15:00:00", start: "13:00:00" }, dueLocal: "2027-02-05T14:00:00" }),
      { previous: null },
    ));
    expect(day.body.start.dateTime).toBe("2027-02-05T15:00:00");
  });

  it.each([
    ["paused", { status: "paused" as const }],
    ["failed", { status: "failed" as const }],
    ["frequent", { recurrence: { interval: 2, unit: "hourly" as const } }],
  ])("has no copy when %s", (reason, overrides) => {
    expect(projectReminderCopy(reminder(overrides), { previous: null })).toEqual({ hidden: true, reason });
  });

  it("titles the copy with the first line and keeps the whole text in the description", () => {
    const content = "**Оплатить** интернет\nСчёт в почте: [ссылка](https://example.com)\n\n![Квитанция](/workspace/bill.pdf)";
    const copy = shown(projectReminderCopy(reminder({ content }), { previous: null }));
    expect(copy.body.summary).toBe("🔔 Оплатить интернет");
    expect(copy.body.description).toBe(
      `Оплатить интернет\nСчёт в почте: ссылка (https://example.com)\n📎 Квитанция\n\n${CALENDAR_MIRROR_COPY_FOOTER}`,
    );
    expect(copyTitle(`${"а".repeat(150)}`)).toBe(`🔔 ${"а".repeat(99)}…`);
    expect(copyTitle("![Фото](/workspace/a.jpg)")).toBe("🔔 📎 Фото");
  });

  it("repeats a series from its kept start while the anchor stays", () => {
    const series = reminder({
      anchorLocal: "2027-01-31T10:00:00",
      dueLocal: "2027-03-31T10:00:00",
      recurrence: { interval: 1, unit: "monthly" },
    });
    const first = shown(projectReminderCopy(series, { previous: null }));
    expect(first.body.start.dateTime).toBe("2027-03-31T10:00:00");
    expect(first.body.recurrence).toEqual(["RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=28,29,30,31;BYSETPOS=-1"]);
    expect(first.seriesStartLocal).toBe("2027-03-31T10:00:00");

    const previous = { pushed: first.pushed, seriesStartLocal: first.seriesStartLocal } as MirrorCopyRow;
    const later = shown(projectReminderCopy({ ...series, dueLocal: "2027-04-30T10:00:00" }, { previous }));
    expect(later.body.start.dateTime).toBe("2027-03-31T10:00:00");
    expect(later.fingerprint).toBe(first.fingerprint);

    const moved = shown(projectReminderCopy(
      { ...series, anchorLocal: "2027-04-30T12:00:00", dueLocal: "2027-04-30T12:00:00" },
      { previous },
    ));
    expect(moved.body.start.dateTime).toBe("2027-04-30T12:00:00");
    expect(moved.fingerprint).not.toBe(first.fingerprint);
  });

  it("shows only the nearest run of a month-end series that quiet hours move past midnight", () => {
    const copy = shown(projectReminderCopy(reminder({
      anchorLocal: "2027-01-31T23:30:00",
      dueLocal: "2027-02-28T23:30:00",
      quiet: { end: "08:00:00", start: "23:00:00" },
      recurrence: { interval: 1, unit: "monthly" },
    }), { previous: null }));
    expect(copy.body.start.dateTime).toBe("2027-03-01T08:00:00");
    expect(copy.body.recurrence).toBeUndefined();
    expect(copy.seriesStartLocal).toBeNull();
  });

  it("keeps a daily series moved past midnight by quiet hours as a series", () => {
    const copy = shown(projectReminderCopy(reminder({
      anchorLocal: "2027-02-05T23:30:00",
      dueLocal: "2027-02-05T23:30:00",
      quiet: { end: "08:00:00", start: "23:00:00" },
      recurrence: { interval: 1, unit: "daily" },
    }), { previous: null }));
    expect(copy.body.start.dateTime).toBe("2027-02-06T08:00:00");
    expect(copy.body.recurrence).toEqual(["RRULE:FREQ=DAILY;INTERVAL=1"]);
  });

  it("changes the fingerprint with every shown field and quiet hours", () => {
    const base = shown(projectReminderCopy(reminder(), { previous: null })).fingerprint;
    const variants = [
      reminder({ content: "Позвонить в банк!" }),
      reminder({ dueLocal: "2027-02-05T11:00:00" }),
      reminder({ timezone: "Europe/Berlin" }),
      reminder({ quiet: { end: "11:00:00", start: "09:00:00" } }),
    ];
    for (const variant of variants) {
      expect(shown(projectReminderCopy(variant, { previous: null })).fingerprint).not.toBe(base);
    }
  });
});

describe("copyTitle", () => {
  it("is a single non-empty line of bounded length for any text", () => {
    fc.assert(fc.property(fc.string({ maxLength: 1_000 }), (content) => {
      const title = copyTitle(content);
      expect(title.startsWith("🔔 ")).toBe(true);
      const text = title.slice("🔔 ".length);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/[\r\n]/u);
      expect([...text].length).toBeLessThanOrEqual(100);
    }));
  });
});

describe("contentWithTitle", () => {
  it("replaces the first line when it is the title the calendar shows", () => {
    expect(contentWithTitle("**Оплатить** интернет\nСчёт в почте", "Оплатить интернет до 10-го"))
      .toBe("Оплатить интернет до 10-го\nСчёт в почте");
  });

  it("keeps a first line the title does not show, such as a file", () => {
    expect(contentWithTitle("![Квитанция](/workspace/bill.pdf)\nОплатить", "Оплатить свет"))
      .toBe("Оплатить свет\n![Квитанция](/workspace/bill.pdf)\nОплатить");
  });
});
