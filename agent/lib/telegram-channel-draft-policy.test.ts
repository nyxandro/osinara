/**
 * Telegram channel draft-rate regression contract.
 *
 * Constructs covered:
 * - The channel starts one native thinking draft at the turn boundary.
 * - Token deltas and tool-loop events never trigger additional draft API calls.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const TELEGRAM_CHANNEL_PATH = new URL("../channels/telegram.ts", import.meta.url);

describe("Telegram channel draft policy", () => {
  it("does not bind high-frequency model or tool events to Telegram drafts", async () => {
    const source = await readFile(TELEGRAM_CHANNEL_PATH, "utf8");

    expect(source).toContain('async "turn.started"');
    expect(source).not.toContain('"message.appended"');
    expect(source).not.toContain('"action.result"');
    expect(source).not.toContain('"actions.requested"');
  });
});
