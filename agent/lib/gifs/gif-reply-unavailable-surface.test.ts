/**
 * GIF reply surface tests without KLIPY or image input.
 *
 * Constructs covered:
 * - GIF replies need both a model that accepts images and a KLIPY key.
 * - Without them no conversation gets the tool or a word about it.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./gif-reply-availability.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./gif-reply-availability.js")>(),
  GIF_REPLIES_AVAILABLE: false,
}));

import { modeInstructions } from "../prompt/mode-instructions.js";
import { buildModeToolSurface } from "../tool-policy/mode-tool-surface.js";
import { gifRepliesAvailable } from "./gif-reply-availability.js";

describe("GIF replies without KLIPY or image input", () => {
  it("need both image input and a KLIPY key", () => {
    expect(gifRepliesAvailable({ klipyApiKey: "key", vision: true })).toBe(true);
    expect(gifRepliesAvailable({ klipyApiKey: "key", vision: false })).toBe(false);
    expect(gifRepliesAvailable({ klipyApiKey: undefined, vision: true })).toBe(false);
    // `KLIPY_API_KEY=` left empty in .env means the integration is not configured.
    expect(gifRepliesAvailable({ klipyApiKey: "", vision: true })).toBe(false);
  });

  it("leave no tool and no rules in any conversation", () => {
    expect(buildModeToolSurface({ environment: "private" })).not.toHaveProperty("send_gif");
    expect(buildModeToolSurface({ environment: "family" })).not.toHaveProperty("send_gif");
    expect(buildModeToolSurface({ capabilities: new Set(), environment: "external", skills: new Set() }))
      .not.toHaveProperty("send_gif");
    for (const instructions of [
      modeInstructions({ environment: "private" }),
      modeInstructions({ environment: "family" }),
      modeInstructions({ capabilities: new Set(), environment: "external" }),
    ]) {
      expect(instructions).not.toContain("send_gif");
    }
  });
});
