/**
 * Where the model is told how to send a place, a poll or a contact card.
 *
 * Constructs covered:
 * - Every live turn that has `send_location`, `send_poll` and `send_contact` gets the rules; a scheduled run, a
 *   delegated child and an external turn without the application core, which have neither, do not.
 * - The widget rule reaches exactly the turns that hold the widget tools: a live private chat (#468).
 */
import { describe, expect, it } from "vitest";

import { modeInstructions } from "./mode-instructions.js";
import { TELEGRAM_NATIVE_SEND_RULES, TELEGRAM_WIDGET_RULES } from "./telegram-send-fragments.js";

describe("TELEGRAM_NATIVE_SEND_RULES in mode instructions", () => {
  it("teaches every live turn and nobody without the tools", () => {
    for (const live of [
      modeInstructions({ environment: "private", owner: true }),
      modeInstructions({ environment: "family" }),
      modeInstructions({ capabilities: new Set(), environment: "external" }),
    ]) expect(live).toContain(TELEGRAM_NATIVE_SEND_RULES);

    for (const without of [
      modeInstructions({ environment: "private", owner: true, scheduledRun: true }),
      modeInstructions({ environment: "family", subagentTurn: true }),
      modeInstructions({ capabilities: new Set(), environment: "external", scheduledRun: true }),
      modeInstructions({ capabilities: new Set(), environment: "external", includeApplicationCore: false }),
    ]) expect(without).not.toContain(TELEGRAM_NATIVE_SEND_RULES);
  });

  it("teaches widgets only where the widget tools are: a live private chat", () => {
    expect(modeInstructions({ environment: "private", owner: true })).toContain(TELEGRAM_WIDGET_RULES);
    expect(modeInstructions({ environment: "private", owner: false } as never)).toContain(TELEGRAM_WIDGET_RULES);
    for (const without of [
      modeInstructions({ environment: "private", owner: true, scheduledRun: true }),
      modeInstructions({ environment: "private", owner: true, subagentTurn: true }),
      modeInstructions({ environment: "family" }),
      modeInstructions({ capabilities: new Set(), environment: "external" }),
    ]) expect(without).not.toContain(TELEGRAM_WIDGET_RULES);
  });
});
