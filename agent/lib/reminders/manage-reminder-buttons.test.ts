/**
 * `manage_reminder` reply button tests.
 *
 * Constructs covered:
 * - A reminder is created with validated buttons, or without any when none are passed.
 * - An update replaces the buttons, or removes them with null; null on create is refused.
 * - Invalid rows reach the model as an actionable error before anything is stored.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({ create: vi.fn(), delete: vi.fn(), update: vi.fn() }));
vi.mock("./reminder-repository.js", () => ({ reminderRepository: repository }));
vi.mock("./reminder-context.js", () => ({ requireReminderAuthorization: vi.fn(() => ({ familyId: "family-1" })) }));

const { default: manageReminder } = await import("../tools/manage_reminder.js");

const ID = "00000000-0000-4000-8000-000000000001";
const CONTEXT = { callId: "call-1" } as never;
const CREATE = {
  action: "create",
  content: "Оплатить интернет",
  firstRunAt: "2026-11-05T10:00:00+03:00",
  recurrence: { interval: 1, unit: "monthly" },
  scope: "personal",
  timezone: "Europe/Moscow",
};
const ROWS = [[{ color: "green", text: "✅ Оплатил" }, { text: "⏰ Через час" }]];

describe("manage_reminder buttons", () => {
  beforeEach(() => {
    repository.create.mockReset().mockResolvedValue({ id: ID });
    repository.update.mockReset().mockResolvedValue({ id: ID });
  });

  it("creates a reminder carrying its buttons", async () => {
    await manageReminder.execute({ ...CREATE, buttons: ROWS } as never, CONTEXT);

    expect(repository.create).toHaveBeenCalledWith({ familyId: "family-1" }, expect.objectContaining({ buttons: ROWS }));
  });

  it("creates a reminder without buttons when none are passed", async () => {
    await manageReminder.execute(CREATE as never, CONTEXT);

    expect(repository.create.mock.calls[0]![1]).not.toHaveProperty("buttons");
  });

  it("refuses null buttons on create", async () => {
    await expect(manageReminder.execute({ ...CREATE, buttons: null } as never, CONTEXT))
      .rejects.toMatchObject({ code: "AGENT_REMINDER_INPUT_INVALID" });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("replaces buttons on update and removes them with null", async () => {
    await manageReminder.execute({ action: "update", buttons: ROWS, id: ID } as never, CONTEXT);
    await manageReminder.execute({ action: "update", buttons: null, id: ID } as never, CONTEXT);

    expect(repository.update.mock.calls[0]![2]).toMatchObject({ buttons: ROWS });
    expect(repository.update.mock.calls[1]![2]).toMatchObject({ buttons: null });
  });

  it("refuses invalid rows before storing anything", async () => {
    await expect(manageReminder.execute({ ...CREATE, buttons: [[{ text: "*Оплатил*" }]] } as never, CONTEXT))
      .rejects.toMatchObject({ code: "AGENT_REPLY_BUTTONS_INPUT_INVALID" });
    expect(repository.create).not.toHaveBeenCalled();
  });
});
