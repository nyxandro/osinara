/** Agreed baseline tools and opt-in Bash for interactive conversation scopes. */
import { describe, expect, it } from "vitest";
import { buildModeToolSurface, buildSubagentToolSurface } from "./mode-tool-surface.js";
import { isGrantableExternalGroupToolName } from "./grantable-group-capabilities.js";

describe("conversation tool matrix", () => {
  it("makes web search and page reading available in every conversation scope", () => {
    for (const environment of ["private", "family", "external"] as const) {
      const input = environment === "external" ? { environment, capabilities: new Set<never>(), skills: new Set<string>() } : { environment };
      const surface = buildModeToolSurface(input);
      expect(surface).toHaveProperty("web_search");
      expect(surface).toHaveProperty("web_fetch");
      expect(buildSubagentToolSurface(input)).toHaveProperty("web_search");
    }
  });
  it("permits the owner to grant Bash while group delegation stays available", () => {
    expect(isGrantableExternalGroupToolName("bash")).toBe(true);
    const surface = buildModeToolSurface({ environment: "external", capabilities: new Set(), skills: new Set<string>() });
    expect(surface).toHaveProperty("agent");
    expect(surface).toHaveProperty("todo");
    expect(surface).toHaveProperty("get_current_time");
  });
});
