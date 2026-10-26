/**
 * Reply buttons on arrival of an update, ahead of the chat queue.
 *
 * Constructs covered:
 * - A reply-button press is acknowledged at once; a person's message removes their earlier buttons
 *   at once. Other updates are left to the queue.
 * - A failure here is logged and never reaches the webhook: the queue step decides the same again.
 * - While a release has frozen the application, nothing is decided on arrival: a choice recorded
 *   then could be lost with a restored backup after the person was told it was accepted.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseTelegramUpdate, type TelegramUpdate } from "../../runtime/telegram/inbound.js";
import { createReplyButtonArrival } from "./reply-button-arrival.js";

function update(raw: Record<string, unknown>): TelegramUpdate {
  const parsed = parseTelegramUpdate(raw);
  if (!parsed) throw new Error("TEST_UPDATE_INVALID");
  return parsed;
}

function callback(data: string): TelegramUpdate {
  return update({
    callback_query: {
      data,
      from: { first_name: "Анна", id: 101, is_bot: false },
      id: "callback-1",
      message: { chat: { id: 101, type: "private" }, date: 1_700_000_000, message_id: 78 },
    },
    update_id: 1002,
  });
}

const MESSAGE = update({
  message: { chat: { id: 101, type: "private" }, date: 1_700_000_000, from: { first_name: "Анна", id: 101, is_bot: false },
    message_id: 77, text: "а доставка сколько?" },
  update_id: 1001,
});

function arrival(admitted = true) {
  const dependencies = {
    acknowledgeReplyButtonPress: vi.fn(async () => undefined),
    admit: vi.fn(async (work: () => Promise<void>) => admitted ? await work() : null),
    dismissReplyButtons: vi.fn(async () => undefined),
    hasButtonsToDismiss: vi.fn(async () => true),
  };
  return { dependencies, onArrival: createReplyButtonArrival(dependencies) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reply buttons on arrival", () => {
  it("acknowledges a reply-button press at once", async () => {
    const { dependencies, onArrival } = arrival();
    const press = callback(`rb:${"A".repeat(22)}:0`);

    await onArrival(press, "1002");

    if (press.kind !== "callback_query") throw new Error("TEST_EXPECTED_CALLBACK");
    expect(dependencies.acknowledgeReplyButtonPress).toHaveBeenCalledWith(press.callbackQuery, "1002");
    expect(dependencies.dismissReplyButtons).not.toHaveBeenCalled();
  });

  it("removes the author's earlier buttons as soon as their message arrives", async () => {
    const { dependencies, onArrival } = arrival();

    await onArrival(MESSAGE, "1001");

    if (MESSAGE.kind !== "message") throw new Error("TEST_EXPECTED_MESSAGE");
    expect(dependencies.dismissReplyButtons).toHaveBeenCalledWith(MESSAGE.message, "1001");
  });

  it("writes nothing for a message whose author has no buttons on screen", async () => {
    const { dependencies, onArrival } = arrival();
    dependencies.hasButtonsToDismiss.mockResolvedValue(false);

    await onArrival(MESSAGE, "1001");

    if (MESSAGE.kind !== "message") throw new Error("TEST_EXPECTED_MESSAGE");
    expect(dependencies.hasButtonsToDismiss).toHaveBeenCalledWith(MESSAGE.message);
    expect(dependencies.admit).not.toHaveBeenCalled();
    expect(dependencies.dismissReplyButtons).not.toHaveBeenCalled();
  });

  it("leaves other buttons to the queue", async () => {
    const { dependencies, onArrival } = arrival();

    await onArrival(callback("su:x:0123456789abcdef"), "1002");

    expect(dependencies.acknowledgeReplyButtonPress).not.toHaveBeenCalled();
    expect(dependencies.dismissReplyButtons).not.toHaveBeenCalled();
  });

  it("decides nothing while a release has frozen the application", async () => {
    const { dependencies, onArrival } = arrival(false);

    await onArrival(callback(`rb:${"A".repeat(22)}:0`), "1002");
    await onArrival(MESSAGE, "1001");

    expect(dependencies.admit).toHaveBeenCalledTimes(2);
    expect(dependencies.acknowledgeReplyButtonPress).not.toHaveBeenCalled();
    expect(dependencies.dismissReplyButtons).not.toHaveBeenCalled();
  });

  it("logs a failure instead of passing it on", async () => {
    const { dependencies, onArrival } = arrival();
    dependencies.dismissReplyButtons.mockRejectedValue(new Error("database busy"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(onArrival(MESSAGE, "1001")).resolves.toBeUndefined();

    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({
      code: "AGENT_REPLY_BUTTONS_ARRIVAL_FAILED",
      error: "database busy",
      updateId: "1001",
    });
  });
});
