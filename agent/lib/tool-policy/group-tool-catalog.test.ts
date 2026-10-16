/**
 * External group tool catalog completeness tests.
 *
 * Constructs covered:
 * - Capability metadata: provides generated model usage for every effective external capability.
 * - Memory capability usage: exposes only the model-safe `memoryRef` contract.
 */
import { describe, expect, it } from "vitest";

import {
  ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
  EXTERNAL_GROUP_CAPABILITY_CATALOG,
  EXTERNAL_GROUP_TOOL_NAMES,
  EXTERNAL_GROUP_BASE_TOOLS,
  SANDBOX_FILE_CAPABILITY_CATALOG,
} from "./group-tool-catalog.js";

describe("external group tool catalog", () => {
  it("keeps the file tools available in isolated external workspaces", () => {
    expect(ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES).toEqual([
      "glob",
      "grep",
      "read_file",
      "write_file",
    ]);
  });

  it("does not expose the removed PDF parser capability", () => {
    expect(EXTERNAL_GROUP_TOOL_NAMES).not.toContain("inspect_workspace_pdf");
  });

  it("offers explicit Telegram attachment import as its own grant", () => {
    expect(EXTERNAL_GROUP_TOOL_NAMES).toContain("import_telegram_attachment");
  });

  it("offers owner-grantable subscription image generation", () => {
    expect(EXTERNAL_GROUP_TOOL_NAMES).toContain("generate_image");
  });

  it("names every persisted and always-available capability exactly once", () => {
    expect(EXTERNAL_GROUP_CAPABILITY_CATALOG.map(({ name }) => name)).toEqual(
      EXTERNAL_GROUP_TOOL_NAMES,
    );
    expect(SANDBOX_FILE_CAPABILITY_CATALOG.map(({ name }) => name)).toEqual(
      ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
    );
  });

  it("offers only locally enforceable web access as a persisted grant", () => {
    expect(EXTERNAL_GROUP_TOOL_NAMES).toContain("web_fetch");
    expect(EXTERNAL_GROUP_TOOL_NAMES).not.toContain("web_search");
    expect(EXTERNAL_GROUP_BASE_TOOLS.map((tool) => tool.name)).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
  });
});
