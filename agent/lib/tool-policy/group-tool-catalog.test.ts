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
    expect(EXTERNAL_GROUP_BASE_TOOLS.map((tool) => tool.name)).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
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

  it("describes memory deletion and conflict resolution without obsolete HITL claims", () => {
    const deleteCapability = EXTERNAL_GROUP_CAPABILITY_CATALOG.find(
      ({ name }) => name === "manage_memory.delete",
    );
    const conflictCapability = EXTERNAL_GROUP_CAPABILITY_CATALOG.find(
      ({ name }) => name === "manage_memory_conflict",
    );

    expect(deleteCapability?.usage).toContain("мягко удалить");
    expect(deleteCapability?.usage).not.toContain("безвозвратно");
    expect(conflictCapability?.usage).toContain("по явному решению пользователя");
    expect(conflictCapability?.usage).not.toContain("подтверждени");
  });
});
