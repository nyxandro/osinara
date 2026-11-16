/**
 * Where the model is told how to send a place, a poll or a contact card.
 *
 * Constructs covered:
 * - Every live turn that has `send_location`, `send_poll` and `send_contact` gets the rules; a scheduled run, a
 *   delegated child and an external turn without the application core, which have neither, do not.
 * - The widget rule reaches exactly the turns that hold the widget tools: a live private chat (#468).
 * - While widgets are switched off, a scenario that asks for a card sends its content as an ordinary
 *   message and does not report the card as undone (#509).
 */
import { describe, expect, it, vi } from "vitest";

// These cases exercise widgets as they work when Telegram accepts them; the switched-off state has
// its own cases in `widget-unavailable-surface.test.ts`.
vi.mock("../widgets/widget-config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../widgets/widget-config.js")>(),
  TELEGRAM_WIDGETS_AVAILABLE: true,
}));

import { modeInstructions } from "./mode-instructions.js";
import { scheduledSendRules, TELEGRAM_NATIVE_SEND_RULES, TELEGRAM_WIDGET_RULES } from "./telegram-send-fragments.js";

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

describe("scheduledSendRules", () => {
  it("sends a card through the widget tool while widgets work", () => {
    const rules = scheduledSendRules({ gifs: false, voice: true, widgets: true });

    expect(rules).toContain("`send_widget`");
    expect(rules).not.toContain("switched off");
  });

  // Telegram switched widgets off on 13.11.2026 (#509): a scenario written for a card must not tell the
  // person every hour that the card did not go out.
  it("turns a requested card into an ordinary message while widgets are switched off", () => {
    const rules = scheduledSendRules({ gifs: false, voice: true, widgets: false });

    expect(rules).not.toContain("send_widget");
    expect(rules).toContain(
      "- Widget cards are switched off for now: where the scenario asks for a card, put its content and buttons into the final text, and do not mention the card or that it was not sent.",
    );
  });
});
