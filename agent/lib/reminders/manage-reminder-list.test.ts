/**
 * `manage_reminder` list action tests.
 *
 * Constructs covered:
 * - The list is an action of the reminder tool: it pages through the person's reminders and changes
 *   nothing, with the limit the separate list tool had.
 * - A list call takes only paging fields; a stray field is refused with an example.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  create: vi.fn(), delete: vi.fn(), list: vi.fn(), operationRecorded: vi.fn(), scopeOf: vi.fn(), update: vi.fn(),
}));
vi.mock("./reminder-repository.js", () => ({ reminderRepository: repository }));
vi.mock("../calendar-mirror/calendar-mirror-outlook.js", () => ({ calendarCopyOutlook: vi.fn(async () => "no_google") }));
vi.mock("./reminder-context.js", () => ({ requireReminderAuthorization: vi.fn(() => ({ familyId: "family-1" })) }));

const { default: manageReminder } = await import("../tools/manage_reminder.js");
const { REMINDER_LIST_DEFAULT_LIMIT } = await import("./reminder-config.js");

const CONTEXT = { callId: "call-1" } as never;
const PAGE = { items: [{ content: "Оплатить интернет", id: "00000000-0000-4000-8000-000000000001" }], nextCursor: "next" };

describe("manage_reminder list", () => {
  beforeEach(() => {
    for (const method of Object.values(repository)) method.mockReset();
    repository.list.mockResolvedValue(PAGE);
  });

  it("pages through the reminders and changes nothing", async () => {
    await expect(manageReminder.execute({ action: "list" } as never, CONTEXT)).resolves.toEqual(PAGE);
    await manageReminder.execute({ action: "list", cursor: "next", limit: 5 } as never, CONTEXT);

    expect(repository.list.mock.calls).toEqual([
      [{ familyId: "family-1" }, { limit: REMINDER_LIST_DEFAULT_LIMIT }],
      [{ familyId: "family-1" }, { cursor: "next", limit: 5 }],
    ]);
    for (const method of [repository.create, repository.update, repository.delete]) expect(method).not.toHaveBeenCalled();
  });

  it("refuses a list call with a field of another action", async () => {
    await expect(manageReminder.execute({ action: "list", id: "x" } as never, CONTEXT)).rejects.toMatchObject({
      code: "AGENT_REMINDER_INPUT_INVALID",
    });
    expect(repository.list).not.toHaveBeenCalled();
  });

  it("names the list in its descriptor and asks for the skill only before a change", () => {
    expect(manageReminder.description).toMatch(/\blist\b/u);
    expect(manageReminder.description).toContain("Load the schedules skill before a change");
  });
});
