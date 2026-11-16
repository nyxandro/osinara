/**
 * Widget surface tests while Telegram widgets are switched off.
 *
 * Constructs covered:
 * - Telegram switched widgets off on 13.11.2026 (#509): no conversation and no scenario gets the
 *   widget tools or the rules that teach them.
 * - A scenario written for a card is told to send its content as an ordinary message instead of
 *   reporting the card as undone.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./widget-config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./widget-config.js")>(),
  TELEGRAM_WIDGETS_AVAILABLE: false,
}));

import { modeInstructions } from "../prompt/mode-instructions.js";
import { TELEGRAM_WIDGET_RULES } from "../prompt/telegram-send-fragments.js";
import { buildModeToolSurface } from "../tool-policy/mode-tool-surface.js";

describe("widgets switched off", () => {
  it("leave no widget tool in a private chat, live or scheduled", () => {
    for (const surface of [
      buildModeToolSurface({ environment: "private", owner: true }),
      buildModeToolSurface({ environment: "private", owner: false } as never),
      buildModeToolSurface({ environment: "private", owner: true, scheduledRun: true }),
    ]) {
      expect(surface).not.toHaveProperty("send_widget");
      expect(surface).not.toHaveProperty("update_widget");
    }
  });

  it("leave no widget rules, and a scenario sends a requested card as an ordinary message", () => {
    const live = modeInstructions({ environment: "private", owner: true });
    const scenario = modeInstructions({ environment: "private", owner: true, scheduledRun: true });

    expect(live).not.toContain(TELEGRAM_WIDGET_RULES);
    for (const instructions of [live, scenario]) expect(instructions).not.toContain("send_widget");
    expect(scenario).toContain("Widget cards are switched off for now");
  });
});
