/**
 * Telegram terminal failure notification privacy tests.
 *
 * Constructs covered:
 * - `shouldNotifyTelegramFailure`: permits private chats and fails closed for every shared target.
 */
import { describe, expect, it } from "vitest";

import { shouldNotifyTelegramFailure } from "./telegram-failure-notification.js";

describe("Telegram failure notification privacy", () => {
  it.each([
    ["private", true],
    ["group", false],
    ["supergroup", false],
    ["channel", false],
    [null, false],
  ] as const)("maps chat type %s to notification=%s", (chatType, expected) => {
    expect(shouldNotifyTelegramFailure({ state: { chatType } } as never)).toBe(expected);
  });
});
