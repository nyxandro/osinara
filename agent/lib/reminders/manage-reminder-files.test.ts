/**
 * `manage_reminder` file checks.
 *
 * Constructs covered:
 * - A file the reminder's chat cannot show is refused before anything is stored: on create by the
 *   scope asked for, on update by the scope the reminder already has.
 * - An update that leaves the content alone checks no file and does not look up the scope.
 * - A public chat's reminder is not checked here: the update itself refuses to change it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({ create: vi.fn(), delete: vi.fn(), scopeOf: vi.fn(), update: vi.fn() }));
vi.mock("./reminder-repository.js", () => ({ reminderRepository: repository }));
vi.mock("./reminder-context.js", () => ({ requireReminderAuthorization: vi.fn(() => ({ familyId: "family-1" })) }));

const { default: manageReminder } = await import("../tools/manage_reminder.js");

const ID = "00000000-0000-4000-8000-000000000001";
const CONTEXT = { callId: "call-1" } as never;
const PERSONAL_FILE = "Собрать документы\n\n![](/workspace/personal/passport.pdf)";

describe("manage_reminder files", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    repository.create.mockResolvedValue({ id: ID });
    repository.update.mockResolvedValue({ id: ID });
  });

  it("refuses a personal file in a new family reminder before storing it", async () => {
    await expect(manageReminder.execute({
      action: "create", content: PERSONAL_FILE, firstRunAt: "2026-11-05T10:00:00+03:00",
      recurrence: null, scope: "family", timezone: "Europe/Moscow",
    } as never, CONTEXT)).rejects.toMatchObject({
      code: "AGENT_REMINDER_INPUT_INVALID",
      message: expect.stringContaining("/workspace/personal/passport.pdf: напоминание придёт в чат, где эта папка недоступна"),
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("checks new content against the scope the reminder already has", async () => {
    repository.scopeOf.mockResolvedValue("family");

    await expect(manageReminder.execute({ action: "update", content: PERSONAL_FILE, id: ID } as never, CONTEXT))
      .rejects.toMatchObject({ code: "AGENT_REMINDER_INPUT_INVALID" });
    expect(repository.scopeOf).toHaveBeenCalledWith({ familyId: "family-1" }, ID);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it("leaves a public chat's reminder to the update, which refuses it", async () => {
    repository.scopeOf.mockResolvedValue("group");

    await manageReminder.execute({ action: "update", content: PERSONAL_FILE, id: ID } as never, CONTEXT);

    expect(repository.update).toHaveBeenCalledTimes(1);
  });

  it("leaves the files alone when the content does not change", async () => {
    await manageReminder.execute({ action: "update", firstRunAt: "2026-11-06T10:00:00+03:00", id: ID } as never, CONTEXT);

    expect(repository.scopeOf).not.toHaveBeenCalled();
    expect(repository.update).toHaveBeenCalledTimes(1);
  });
});
