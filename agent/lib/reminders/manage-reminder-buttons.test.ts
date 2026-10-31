/**
 * `manage_reminder` reply button tests.
 *
 * Constructs covered:
 * - Buttons are written as markup at the end of `content`: the reminder stores the text without
 *   them and the buttons apart; content without markup carries none.
 * - New content brings its own buttons, or none, while an update that leaves the content alone
 *   keeps them.
 * - Refused markup reaches the model as an actionable error with an example before anything is
 *   stored, and the text limit applies to the text alone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({ create: vi.fn(), delete: vi.fn(), scopeOf: vi.fn(), update: vi.fn() }));
vi.mock("./reminder-repository.js", () => ({ reminderRepository: repository }));
vi.mock("./reminder-context.js", () => ({ requireReminderAuthorization: vi.fn(() => ({ familyId: "family-1" })) }));

const { default: manageReminder } = await import("../tools/manage_reminder.js");

const ID = "00000000-0000-4000-8000-000000000001";
const CONTEXT = { callId: "call-1" } as never;
const MARKUP = "<tg-button-row><tg-button style=\"success\">✅ Оплатил</tg-button><tg-button>⏰ Через час</tg-button></tg-button-row>";
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
    repository.scopeOf.mockReset().mockResolvedValue("personal");
  });

  it("creates a reminder carrying the buttons written at the end of its content", async () => {
    await manageReminder.execute({ ...CREATE, content: `Оплатить интернет\n\n${MARKUP}` } as never, CONTEXT);

    expect(repository.create).toHaveBeenCalledWith({ familyId: "family-1" }, expect.objectContaining({
      buttons: ROWS,
      content: "Оплатить интернет",
    }));
  });

  it("creates a reminder without buttons when its content has none", async () => {
    await manageReminder.execute(CREATE as never, CONTEXT);

    expect(repository.create.mock.calls[0]![1]).toMatchObject({ content: "Оплатить интернет" });
    expect(repository.create.mock.calls[0]![1]).not.toHaveProperty("buttons");
  });

  it("takes the buttons from new content, removes them with content that has none, and keeps them otherwise", async () => {
    await manageReminder.execute({ action: "update", content: `Оплатить ТВ\n\n${MARKUP}`, id: ID } as never, CONTEXT);
    await manageReminder.execute({ action: "update", content: "Оплатить ТВ", id: ID } as never, CONTEXT);
    await manageReminder.execute({ action: "update", firstRunAt: "2026-11-06T10:00:00+03:00", id: ID } as never, CONTEXT);

    expect(repository.update.mock.calls[0]![2]).toMatchObject({ buttons: ROWS, content: "Оплатить ТВ" });
    expect(repository.update.mock.calls[1]![2]).toMatchObject({ buttons: null, content: "Оплатить ТВ" });
    expect(repository.update.mock.calls[2]![2]).not.toHaveProperty("buttons");
  });

  it("refuses refused markup with the reason and an example before storing anything", async () => {
    const content = "Оплатить интернет\n\n<tg-button-row><tg-button type=\"url\" url=\"https://pay.example\">Оплатить</tg-button></tg-button-row>";

    await expect(manageReminder.execute({ ...CREATE, content } as never, CONTEXT)).rejects.toMatchObject({
      code: "AGENT_REMINDER_INPUT_INVALID",
      message: expect.stringMatching(/только ответом[\s\S]*<tg-button-row>/u),
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("refuses content made of buttons alone", async () => {
    await expect(manageReminder.execute({ ...CREATE, content: MARKUP } as never, CONTEXT))
      .rejects.toMatchObject({ code: "AGENT_REMINDER_INPUT_INVALID" });
  });

  it("measures the length limit on the text without its buttons", async () => {
    const text = "я".repeat(1_000);

    await manageReminder.execute({ ...CREATE, content: `${text}\n\n${MARKUP}` } as never, CONTEXT);
    await expect(manageReminder.execute({ ...CREATE, content: `${text}я\n\n${MARKUP}` } as never, CONTEXT))
      .rejects.toMatchObject({ code: "AGENT_REMINDER_INPUT_INVALID" });
  });

  it("no longer takes buttons as a separate field", async () => {
    await expect(manageReminder.execute({ ...CREATE, buttons: ROWS } as never, CONTEXT))
      .rejects.toMatchObject({ code: "AGENT_REMINDER_INPUT_INVALID" });
  });
});
