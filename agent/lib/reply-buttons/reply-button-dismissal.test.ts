/**
 * Reply button dismissal tests.
 *
 * Constructs covered:
 * - Only a person's own message dismisses their buttons, as of the moment it was written and of
 *   its place in the update order, so a tap that came first still counts.
 * - Every dismissed message gets the "nothing chosen" caption, and one failed edit does not keep
 *   the others.
 */
import { describe, expect, it, vi } from "vitest";

import { parseTelegramUpdate, type TelegramMessage } from "../../runtime/telegram/inbound.js";
import { createReplyButtonDismissal } from "./reply-button-dismissal.js";

function message(from: Record<string, unknown> | null): TelegramMessage {
  const update = parseTelegramUpdate({
    message: {
      chat: { id: -100777, type: "supergroup" },
      date: 1_793_000_000,
      ...(from === null ? {} : { from }),
      message_id: 60,
      text: "а доставка сколько?",
    },
    update_id: 7002,
  });
  if (update?.kind !== "message") throw new Error("TEST_MESSAGE_INVALID");
  return update.message;
}

function dismissal(sets: unknown[]) {
  const repository = { dismissForAddressee: vi.fn().mockResolvedValue(sets) };
  const telegram = { settle: vi.fn().mockResolvedValue(undefined) };
  return { dismiss: createReplyButtonDismissal({ repository, telegram }), repository, telegram };
}

describe("reply button dismissal", () => {
  it("dismisses the author's buttons written before the message, with a caption", async () => {
    const sets = [{ id: "set-1" }, { id: "set-2" }];
    const { dismiss, repository, telegram } = dismissal(sets);

    await dismiss(message({ first_name: "Андрей", id: 101, is_bot: false }), "7002");

    expect(repository.dismissForAddressee).toHaveBeenCalledWith({
      addresseeTelegramUserId: "101",
      afterUpdateId: "7002",
      telegramChatId: "-100777",
      writtenAt: new Date(1_793_000_000 * 1_000),
    });
    expect(telegram.settle.mock.calls).toEqual([[sets[0], "Ничего не выбрано"], [sets[1], "Ничего не выбрано"]]);
  });

  it("ignores a message of another bot or without a sender", async () => {
    const { dismiss, repository } = dismissal([]);

    await dismiss(message({ first_name: "Бот", id: 555, is_bot: true }), "7002");
    await dismiss(message(null), "7002");

    expect(repository.dismissForAddressee).not.toHaveBeenCalled();
  });

  it("edits the remaining messages when one edit fails", async () => {
    const sets = [{ id: "set-1" }, { id: "set-2" }];
    const { dismiss, telegram } = dismissal(sets);
    telegram.settle.mockRejectedValueOnce(new Error("message to edit not found"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await dismiss(message({ first_name: "Андрей", id: 101, is_bot: false }), "7002");

    expect(telegram.settle).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
});
