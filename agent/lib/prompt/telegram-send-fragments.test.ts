/**
 * Where the model is told how to send a place or a poll.
 *
 * Constructs covered:
 * - Every live turn that has `send_location` and `send_poll` gets the rules; a scheduled run, a
 *   delegated child and an external turn without the application core, which have neither, do not.
 */
import { describe, expect, it } from "vitest";

import { modeInstructions } from "./mode-instructions.js";
import { PLACE_AND_POLL_RULES } from "./telegram-send-fragments.js";

describe("PLACE_AND_POLL_RULES in mode instructions", () => {
  it("teaches every live turn and nobody without the tools", () => {
    for (const live of [
      modeInstructions({ environment: "private" }),
      modeInstructions({ environment: "family" }),
      modeInstructions({ capabilities: new Set(), environment: "external" }),
    ]) expect(live).toContain(PLACE_AND_POLL_RULES);

    for (const without of [
      modeInstructions({ environment: "private", scheduledRun: true }),
      modeInstructions({ environment: "family", subagentTurn: true }),
      modeInstructions({ capabilities: new Set(), environment: "external", scheduledRun: true }),
      modeInstructions({ capabilities: new Set(), environment: "external", includeApplicationCore: false }),
    ]) expect(without).not.toContain(PLACE_AND_POLL_RULES);
  });
});
