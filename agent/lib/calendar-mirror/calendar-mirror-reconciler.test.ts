/**
 * One minute of the calendar mirror for each connected Google profile.
 *
 * Constructs covered:
 * - The calendar is created once under a fresh marker, or found by the marker after a lost answer.
 * - A profile held by the model, or a spent budget, waits for the next minute without a failure.
 * - Lost access, a calendar deleted for good and a calendar Google refuses stop the mirror and tell
 *   the person once; a single «no such calendar» does not, because Google deletes over minutes.
 * - Temporary Google failures back off 1, 2, 4… up to 60 minutes.
 */
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { CalendarCallError } from "../google-workspace/google-calendar-client.js";
import type { CalendarMirrorActor, CalendarMirrorProfile } from "./calendar-mirror-contract.js";
import { blankCopy, fakeCalendar, fakeRepository, PROFILE, reminderSource } from "./calendar-mirror-fakes.test-support.js";
import type { CalendarMirrorNotice } from "./calendar-mirror-cycle-context.js";
import { type ReconcilerDependencies, reconcileCalendarMirrors } from "./calendar-mirror-reconciler.js";

const NOW = new Date("2027-02-03T09:00:00Z");
const ACTOR: CalendarMirrorActor = { role: "owner", telegramUserId: "tg-1", userId: "user-1" };

function setup(input: {
  actor?: CalendarMirrorActor | null;
  profile?: Partial<CalendarMirrorProfile>;
  reminders?: number;
  token?: "busy" | Error;
} = {}) {
  const profile = { ...PROFILE, ...input.profile };
  const google = fakeCalendar();
  const storage = fakeRepository({
    reminders: Array.from({ length: input.reminders ?? 0 }, (_, index) =>
      reminderSource({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` })),
  });
  const notices: CalendarMirrorNotice[] = [];
  const calendars = { created: [] as Array<{ description: string; summary: string }>, found: null as string | null };
  let clock = NOW.getTime();
  const repository = {
    ...storage.repository,
    deferUntil: vi.fn(async () => undefined),
    dueProfiles: vi.fn(async () => [{ actor: input.actor === undefined ? ACTOR : input.actor, profile }]),
    markCalendarMissing: vi.fn(async (_workspaceId: string, now: Date) => profile.calendarMissingSince ?? now),
    recordFailure: vi.fn(async () => undefined),
    recordSuccess: vi.fn(async () => undefined),
    releaseStaleRemoving: vi.fn(async () => undefined),
    setCalendar: vi.fn(async (_workspaceId: string, calendarId: string) => { profile.calendarId = calendarId; }),
    setCalendarMarker: vi.fn(async (_workspaceId: string, marker: string) => { profile.calendarMarker = marker; }),
    stop: vi.fn(async () => true),
  };
  const client = {
    ...google.calendar,
    findCalendarByMarker: vi.fn(async () => calendars.found),
    insertCalendar: vi.fn(async (calendar: { description: string; summary: string }) => {
      calendars.created.push(calendar);
      return { id: "created@group.calendar.google.com" };
    }),
  };
  const dependencies: ReconcilerDependencies = {
    access: {
      async guard(_auth, call) {
        clock += 100;
        return { busy: false, value: await call() };
      },
      async token() {
        if (input.token === "busy") return { busy: true };
        if (input.token instanceof Error) throw input.token;
        return { accessToken: "token", busy: false };
      },
    },
    calendarClient: () => client,
    clock: () => clock,
    notices: { send: async (_profile, notice) => { notices.push(notice); } },
    repository,
    writes: {
      applyCalendarEdit: vi.fn(async () => "applied" as const),
      createReminderFromEvent: vi.fn(async () => ({ reminderId: "r" })),
      deleteReminderFromCalendar: vi.fn(async () => "deleted" as const),
    },
  };
  return { calendars, client, dependencies, google, notices, profile, repository, storage };
}

describe("reconcileCalendarMirrors", () => {
  it("creates the calendar under a fresh marker, then pulls and pushes", async () => {
    const run = setup({ profile: { calendarId: null, calendarMarker: null, syncToken: null }, reminders: 1 });
    await reconcileCalendarMirrors(run.dependencies, NOW);
    expect(run.calendars.created).toEqual([{
      description: expect.stringContaining(run.profile.calendarMarker!),
      summary: "Осинара — напоминания",
    }]);
    expect(run.profile.calendarMarker).toMatch(/^osinara-mirror:workspace-1:[0-9a-f-]{36}$/u);
    expect(run.repository.setCalendar).toHaveBeenCalledWith("workspace-1", "created@group.calendar.google.com");
    expect(run.google.calls.map(([method]) => method)).toEqual(["list", "insert"]);
    expect(run.repository.recordSuccess).toHaveBeenCalledWith("workspace-1");
  });

  it("finds the calendar by its marker when the answer to its creation was lost", async () => {
    const run = setup({ profile: { calendarId: null, calendarMarker: "osinara-mirror:workspace-1:lost" } });
    run.calendars.found = "found@group.calendar.google.com";
    await reconcileCalendarMirrors(run.dependencies, NOW);
    expect(run.client.insertCalendar).not.toHaveBeenCalled();
    expect(run.repository.setCalendar).toHaveBeenCalledWith("workspace-1", "found@group.calendar.google.com");
  });

  it("names the family calendar for the family", async () => {
    const run = setup({ profile: { calendarId: null, calendarMarker: null, ownerUserId: null, scope: "family" } });
    await reconcileCalendarMirrors(run.dependencies, NOW);
    expect(run.calendars.created[0]!.summary).toBe("Осинара — семейные напоминания");
  });

  it("waits for the next minute while the model holds the profile", async () => {
    const run = setup({ token: "busy" });
    await reconcileCalendarMirrors(run.dependencies, NOW);
    expect(run.google.calls).toEqual([]);
    expect(run.repository.recordFailure).not.toHaveBeenCalled();
    expect(run.repository.recordSuccess).not.toHaveBeenCalled();
  });

  it("stops at the write budget and keeps the rest for the next minute", async () => {
    const run = setup({ reminders: 25 });
    await reconcileCalendarMirrors(run.dependencies, NOW);
    expect(run.google.calls.filter(([method]) => method === "insert")).toHaveLength(20);
    expect(run.repository.recordFailure).not.toHaveBeenCalled();
    expect(run.repository.recordSuccess).not.toHaveBeenCalled();
  });

  it.each([
    ["an expired grant", new AppError("AGENT_GOOGLE_AUTH_EXPIRED", "истёк")],
    ["missing permissions", new AppError("AGENT_GOOGLE_SCOPE_MISSING", "нет прав")],
  ])("stops on %s and tells once", async (_case, error) => {
    const run = setup({ token: error });
    await reconcileCalendarMirrors(run.dependencies, NOW);
    expect(run.repository.stop).toHaveBeenCalledWith("workspace-1", "stopped_access_lost", "AGENT_CALENDAR_MIRROR_ACCESS_LOST");
    expect(run.notices).toEqual([{ kind: "access_lost" }]);

    run.repository.stop.mockResolvedValueOnce(false);
    run.notices.length = 0;
    await reconcileCalendarMirrors(run.dependencies, NOW);
    expect(run.notices).toEqual([]);
  });

  it("stops without a message when the profile's owner left the family", async () => {
    const run = setup({ actor: null });
    await reconcileCalendarMirrors(run.dependencies, NOW);
    expect(run.repository.stop).toHaveBeenCalledWith("workspace-1", "stopped_access_lost", "AGENT_CALENDAR_MIRROR_ACCESS_LOST");
    expect(run.notices).toEqual([]);
  });

  it("backs off on temporary Google failures", async () => {
    const run = setup({ profile: { consecutiveFailures: 3 } });
    run.google.fail("list", new CalendarCallError("transient", 503, "backendError"));
    await reconcileCalendarMirrors(run.dependencies, NOW);
    expect(run.repository.recordFailure).toHaveBeenCalledWith(
      "workspace-1",
      "AGENT_CALENDAR_MIRROR_PROVIDER_UNAVAILABLE",
      new Date(NOW.getTime() + 8 * 60_000),
    );
    const capped = setup({ profile: { consecutiveFailures: 12 } });
    capped.google.fail("list", new CalendarCallError("transient", 429, "rateLimitExceeded"));
    await reconcileCalendarMirrors(capped.dependencies, NOW);
    expect(capped.repository.recordFailure).toHaveBeenCalledWith(
      "workspace-1",
      "AGENT_CALENDAR_MIRROR_PROVIDER_UNAVAILABLE",
      new Date(NOW.getTime() + 60 * 60_000),
    );
  });

  it("counts a calendar deleted only when it stays missing for five minutes", async () => {
    const first = setup();
    first.google.fail("list", new CalendarCallError("not_found", 404, "notFound"));
    await reconcileCalendarMirrors(first.dependencies, NOW);
    expect(first.repository.stop).not.toHaveBeenCalled();
    expect(first.repository.deferUntil).toHaveBeenCalledWith("workspace-1", new Date(NOW.getTime() + 5 * 60_000));

    const later = setup({ profile: { calendarMissingSince: new Date(NOW.getTime() - 5 * 60_000) } });
    later.google.fail("list", new CalendarCallError("not_found", 404, "notFound"));
    await reconcileCalendarMirrors(later.dependencies, NOW);
    expect(later.repository.stop).toHaveBeenCalledWith("workspace-1", "stopped_calendar_deleted", "AGENT_CALENDAR_MIRROR_CALENDAR_DELETED");
    expect(later.notices).toEqual([{ kind: "calendar_deleted" }]);
  });

  it("stops when Google refuses to create the calendar", async () => {
    const run = setup({ profile: { calendarId: null, calendarMarker: null } });
    run.client.insertCalendar.mockRejectedValueOnce(new CalendarCallError("rejected", 403, "forbidden"));
    await reconcileCalendarMirrors(run.dependencies, NOW);
    expect(run.repository.stop).toHaveBeenCalledWith("workspace-1", "stopped_calendar_refused", "AGENT_CALENDAR_MIRROR_CALENDAR_REFUSED");
    expect(run.notices).toEqual([{ kind: "calendar_refused" }]);
  });

  it("does nothing for a profile whose calendar is being removed", async () => {
    const run = setup({ profile: { state: "removing" } });
    run.storage.copies.set("c", { ...blankCopy("c", "osrx"), fingerprint: "a".repeat(64), shown: true });
    await reconcileCalendarMirrors(run.dependencies, NOW);
    expect(run.google.calls).toEqual([]);
  });

  it("stops and tells once when the calendar itself was deleted, keeping every reminder", async () => {
    const run = setup();
    const copy = (id: string) => ({ ...blankCopy(id, `osr${id}`), fingerprint: "a".repeat(64), reminderId: `r-${id}`, shown: true });
    run.storage.copies.set("c1", copy("c1"));
    run.storage.copies.set("c2", copy("c2"));
    run.google.changes.items = [
      { etag: "\"x\"", id: "osrc1", status: "cancelled" },
      { etag: "\"y\"", id: "osrc2", status: "cancelled" },
    ];
    await reconcileCalendarMirrors(run.dependencies, NOW);
    expect(run.dependencies.writes.deleteReminderFromCalendar).not.toHaveBeenCalled();
    expect(run.repository.stop).toHaveBeenCalledWith("workspace-1", "stopped_calendar_deleted", "AGENT_CALENDAR_MIRROR_CALENDAR_DELETED");
    expect(run.notices).toEqual([{ kind: "calendar_deleted" }]);
  });
});
