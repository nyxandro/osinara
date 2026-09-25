/**
 * Turn interjection delivery record tests.
 *
 * Constructs covered:
 * - An eligible turn records delivery at each model step; other turns never touch the table.
 * - A failed record is logged and never fails the person's turn.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { recordTurnInterjectionDelivery } from "./turn-interjection-delivery.js";

function context(attributes: Record<string, unknown>) {
  return {
    session: {
      auth: {
        current: {
          attributes: {
            applicationSessionId: "00000000-0000-4000-8000-0000000000a1",
            osinaraTelegramUpdateId: "500",
            telegramActorKind: "telegram_user",
            telegramChatId: "101",
            telegramChatType: "private",
            telegramTurnInterjectionMarker: "0123456789abcdef01234567",
            telegramUserId: "101",
            ...attributes,
          },
          authenticator: "telegram",
          principalId: "user-1",
          principalType: "user" as const,
        },
        initiator: null,
      },
      id: "ses_1",
      turn: { id: "turn_2" },
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("recordTurnInterjectionDelivery", () => {
  it("marks the turn's returned messages delivered", async () => {
    const repository = { markDelivered: vi.fn(async () => 1) };
    await recordTurnInterjectionDelivery(context({}), repository);
    expect(repository.markDelivered).toHaveBeenCalledWith("ses_1", "turn_2");
  });

  it("ignores a turn that cannot receive messages meanwhile", async () => {
    const repository = { markDelivered: vi.fn(async () => 0) };
    await recordTurnInterjectionDelivery(context({ telegramTurnInterjectionMarker: undefined }), repository);
    expect(repository.markDelivered).not.toHaveBeenCalled();
  });

  it("logs a failed record instead of failing the turn", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const repository = { markDelivered: vi.fn(async () => { throw new Error("database unavailable"); }) };

    await expect(recordTurnInterjectionDelivery(context({}), repository)).resolves.toBeUndefined();
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ code: "AGENT_TURN_INTERJECTION_DELIVERY_RECORD_FAILED" });
  });
});
