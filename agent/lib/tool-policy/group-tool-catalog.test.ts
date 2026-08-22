/**
 * External group tool catalog completeness tests.
 *
 * Constructs covered:
 * - `FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS`: covers the Eve built-ins that cannot be hidden.
 * - Capability metadata: provides generated model usage for every effective external capability.
 * - Memory capability usage: exposes only the model-safe `memoryRef` contract.
 */
import { describe, expect, it } from "vitest";

import {
  ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
  EXTERNAL_GROUP_CAPABILITY_CATALOG,
  EXTERNAL_GROUP_TOOL_NAMES,
  FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS,
  SANDBOX_FILE_CAPABILITY_CATALOG,
} from "./group-tool-catalog.js";

describe("external group tool catalog", () => {
  it("denies every framework built-in an external group must not reach", () => {
    // Application tools are emitted per mode, so only framework descriptors need an override.
    expect([...FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS].sort()).toEqual([
      "agent",
      "ask_question",
      "bash",
      "todo",
      "web_fetch",
      "web_search",
    ]);
  });

  it("does not override native file tools in isolated external workspaces", () => {
    expect(ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES).toEqual([
      "glob",
      "grep",
      "read_file",
      "write_file",
    ]);
    for (const toolName of ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES) {
      expect(FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS).not.toContain(toolName);
    }
  });

  it("does not expose the removed PDF parser capability", () => {
    expect(EXTERNAL_GROUP_TOOL_NAMES).not.toContain("inspect_workspace_pdf");
  });

  it("offers explicit Telegram attachment import without granting Bash", () => {
    expect(EXTERNAL_GROUP_TOOL_NAMES).toContain("import_telegram_attachment");
    expect(FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS).toContain("bash");
  });

  it("offers owner-grantable subscription image generation with Telegram delivery", () => {
    expect(EXTERNAL_GROUP_TOOL_NAMES).toContain("generate_image");
    expect(EXTERNAL_GROUP_CAPABILITY_CATALOG.find(({ name }) => name === "generate_image")?.usage)
      .toMatch(/создавать.*отправлять/iu);
  });

  it("defines non-empty model usage for every persisted and always-available capability", () => {
    expect(EXTERNAL_GROUP_CAPABILITY_CATALOG.map(({ name }) => name)).toEqual(
      EXTERNAL_GROUP_TOOL_NAMES,
    );
    expect(SANDBOX_FILE_CAPABILITY_CATALOG.map(({ name }) => name)).toEqual(
      ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
    );
    for (const capability of [
      ...EXTERNAL_GROUP_CAPABILITY_CATALOG,
      ...SANDBOX_FILE_CAPABILITY_CATALOG,
    ]) {
      expect(capability.usage.trim()).not.toBe("");
    }
  });

  it("offers only locally enforceable web access as a persisted grant", () => {
    expect(EXTERNAL_GROUP_TOOL_NAMES).toContain("web_fetch");
    expect(EXTERNAL_GROUP_TOOL_NAMES).not.toContain("web_search");
    expect(FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS).toContain("web_search");
    expect(FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS).toContain("agent");
  });

  it("describes external memory mutations through model-safe memoryRef values", () => {
    const mutationUsage = EXTERNAL_GROUP_CAPABILITY_CATALOG
      .filter(({ name }) => name.startsWith("manage_memory."))
      .map(({ usage }) => usage);

    expect(mutationUsage).toHaveLength(3);
    for (const usage of mutationUsage) {
      expect(usage).toContain("memoryRef");
      expect(usage).not.toMatch(/\bID\b/u);
    }
  });
});
