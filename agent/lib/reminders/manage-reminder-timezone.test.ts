/**
 * `manage_reminder` and a timezone nobody named yet (#451).
 *
 * Constructs covered:
 * - The first run is named exactly one way, and a clock time carries no offset.
 * - A waiting reminder comes back with the step the agent takes next, and changes, cancellation and
 *   a refused pause are routed to the wait.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  create: vi.fn(), delete: vi.fn(), operationRecorded: vi.fn(), scopeOf: vi.fn(), update: vi.fn(),
}));
const creation = vi.hoisted(() => ({ createReminderOrWait: vi.fn() }));
const waits = vi.hoisted(() => ({ delete: vi.fn(), operationRecorded: vi.fn(), scopeOf: vi.fn(), update: vi.fn() }));
vi.mock("./reminder-repository.js", () => ({ reminderRepository: repository }));
vi.mock("./reminder-create.js", () => creation);
vi.mock("./reminder-timezone-wait-repository.js", () => ({ timezoneWaitRepository: waits }));
vi.mock("../calendar-mirror/calendar-mirror-outlook.js", () => ({ calendarCopyOutlook: vi.fn(async () => "no_google") }));
vi.mock("./reminder-context.js", () => ({ requireReminderAuthorization: vi.fn(() => ({ familyId: "family-1" })) }));

const { default: manageReminder } = await import("../tools/manage_reminder.js");

const ID = "00000000-0000-4000-8000-000000000001";
const CONTEXT = { callId: "call-1" } as never;
const BASE = { action: "create", content: "Полить цветы", recurrence: null, scope: "personal" };
const AWAITING = {
  content: "Полить цветы", createdAt: "2026-11-03T07:00:00.000Z", id: ID, localFirstRun: "2026-11-05T09:00",
  recurrence: null, scope: "personal", status: "awaiting_timezone", suggestedLabel: "Москва", suggestedTimezone: "Europe/Moscow",
};

describe("manage_reminder without the person's timezone", () => {
  beforeEach(() => {
    creation.createReminderOrWait.mockReset().mockResolvedValue({ awaiting: AWAITING, kind: "awaiting" });
    for (const mock of [repository.operationRecorded, waits.operationRecorded]) mock.mockReset().mockResolvedValue(false);
    waits.scopeOf.mockReset().mockResolvedValue(null);
    waits.update.mockReset().mockResolvedValue(AWAITING);
    waits.delete.mockReset().mockResolvedValue(true);
    repository.update.mockReset().mockResolvedValue({ id: ID });
  });

  it("passes the clock time the person said and tells the agent what to do while it waits", async () => {
    const result = await manageReminder.execute({ ...BASE, localFirstRun: "2026-11-05T09:00" } as never, CONTEXT);

    expect(creation.createReminderOrWait).toHaveBeenCalledWith({ familyId: "family-1" }, expect.objectContaining({
      operationKey: "call-1",
      time: { kind: "local", local: "2026-11-05T09:00:00" },
    }));
    expect(result).toMatchObject({ status: "awaiting_timezone" });
    expect((result as { nextStep: string }).nextStep).toContain("«Да, Москва» and «Другой пояс»");
  });

  it("passes a countdown in minutes", async () => {
    creation.createReminderOrWait.mockResolvedValue({ kind: "reminder", reminder: { id: ID } });
    await manageReminder.execute({ ...BASE, firstRunInMinutes: 20 } as never, CONTEXT);
    expect(creation.createReminderOrWait.mock.calls[0]![1]).toMatchObject({ time: { kind: "countdown", minutes: 20 } });
  });

  it("refuses two ways of naming the time and a clock time with an offset", async () => {
    await expect(manageReminder.execute(
      { ...BASE, firstRunInMinutes: 20, localFirstRun: "2026-11-05T09:00" } as never,
      CONTEXT,
    )).rejects.toThrowError(/AGENT_REMINDER_TIME_INPUT_AMBIGUOUS/);
    await expect(manageReminder.execute({ ...BASE, localFirstRun: "2026-11-05T09:00:00+03:00" } as never, CONTEXT))
      .rejects.toThrowError(/AGENT_REMINDER_LOCAL_TIME_INVALID/);
    expect(creation.createReminderOrWait).not.toHaveBeenCalled();
  });

  it("changes and cancels a waiting reminder, and refuses to pause it", async () => {
    waits.scopeOf.mockResolvedValue("personal");
    await manageReminder.execute({ action: "update", id: ID, localFirstRun: "2026-11-06T10:30" } as never, CONTEXT);
    expect(waits.update).toHaveBeenCalledWith({ familyId: "family-1" }, ID, expect.objectContaining({ localFirstRun: "2026-11-06T10:30:00" }));
    await expect(manageReminder.execute({ action: "delete", id: ID } as never, CONTEXT)).resolves.toEqual({ deleted: true });
    await expect(manageReminder.execute({ action: "pause", id: ID } as never, CONTEXT))
      .rejects.toThrowError(/AGENT_REMINDER_AWAITING_ACTION_UNSUPPORTED/);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it("keeps a clock time without a zone for waiting reminders only", async () => {
    await expect(manageReminder.execute({ action: "update", id: ID, localFirstRun: "2026-11-06T10:30" } as never, CONTEXT))
      .rejects.toThrowError(/AGENT_REMINDER_INPUT_INVALID.*localFirstRun/);
    expect(repository.update).not.toHaveBeenCalled();
  });
});
