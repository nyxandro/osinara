/**
 * GIF reply surface tests with KLIPY and image input configured.
 *
 * Constructs covered:
 * - Every live conversation gets `send_gif` without a grant: private chat, family group and an
 *   external group alike.
 * - A scheduled run, a delegated child and a turn without the application core get neither the
 *   tool nor its rules: none of them answers a live participant.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./gif-reply-availability.js", () => ({
  GIF_REPLIES_AVAILABLE: true,
}));

import { modeInstructions } from "../prompt/mode-instructions.js";
import { buildModeToolSurface, buildSubagentToolSurface } from "../tool-policy/mode-tool-surface.js";

const EXTERNAL = { capabilities: new Set<never>(), environment: "external", skills: new Set<string>() } as const;

describe("GIF replies with KLIPY configured", () => {
  it("are offered in every live conversation without a grant", () => {
    expect(buildModeToolSurface({ environment: "private" })).toHaveProperty("send_gif");
    expect(buildModeToolSurface({ environment: "family" })).toHaveProperty("send_gif");
    expect(buildModeToolSurface(EXTERNAL)).toHaveProperty("send_gif");
  });

  it("are not offered where nobody live is answered", () => {
    expect(buildModeToolSurface({ environment: "private", scheduledRun: true })).not.toHaveProperty("send_gif");
    expect(buildModeToolSurface({ environment: "family", scheduledRun: true })).not.toHaveProperty("send_gif");
    expect(buildModeToolSurface({ ...EXTERNAL, scheduledRun: true })).not.toHaveProperty("send_gif");
    expect(buildModeToolSurface({ ...EXTERNAL, includeApplicationCore: false })).not.toHaveProperty("send_gif");
    expect(buildSubagentToolSurface({ environment: "private" })).not.toHaveProperty("send_gif");
    expect(buildSubagentToolSurface(EXTERNAL)).not.toHaveProperty("send_gif");
  });

  it("carry their rules only into live conversations", () => {
    for (const instructions of [
      modeInstructions({ environment: "private" }),
      modeInstructions({ environment: "family" }),
      modeInstructions({ capabilities: new Set(), environment: "external" }),
    ]) {
      expect(instructions).toContain("## Answering with a GIF");
    }
    for (const instructions of [
      modeInstructions({ environment: "private", scheduledRun: true }),
      modeInstructions({ environment: "family", subagentTurn: true }),
      modeInstructions({ capabilities: new Set(), environment: "external", scheduledRun: true }),
      modeInstructions({ capabilities: new Set(), environment: "external", includeApplicationCore: false }),
    ]) {
      expect(instructions).not.toContain("send_gif");
    }
  });
});
