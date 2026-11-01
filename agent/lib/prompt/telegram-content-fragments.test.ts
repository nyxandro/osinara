/**
 * How every chat mode reads the lines the server writes for content a person did not type.
 *
 * Constructs covered:
 * - Every mode, an external group without the application core included, carries the rules: the
 *   lines reach the timeline of any chat.
 * - Only a mode that can look at images is told to look at the still of a sticker, GIF or video.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../model-vision-availability.js", () => ({ MODEL_VISION_AVAILABLE: true }));

import { modeInstructions } from "./mode-instructions.js";
import { telegramContentRules } from "./telegram-content-fragments.js";

describe("telegramContentRules in mode instructions", () => {
  it("explains the server-written content lines in every chat mode", () => {
    const withImages = telegramContentRules(true);

    expect(modeInstructions({ environment: "private" })).toContain(withImages);
    expect(modeInstructions({ environment: "family" })).toContain(withImages);
    expect(modeInstructions({ capabilities: new Set(), environment: "external" })).toContain(withImages);
    expect(modeInstructions({ capabilities: new Set(), environment: "external", includeApplicationCore: false }))
      .toContain(telegramContentRules(false));
  });

  it("names the image tool only where it can be used", () => {
    expect(telegramContentRules(true)).toContain("inspect_workspace_image");
    expect(telegramContentRules(false)).not.toContain("inspect_workspace_image");
  });
});
