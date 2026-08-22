/**
 * Eve dynamic capability resolver tests.
 *
 * Constructs covered:
 * - `capabilities`: one step-scoped map per verified mode instead of replayed helper closures.
 * - An unresolvable mode or failed policy lookup retains only fail-closed baseline wrappers.
 * - Scheduled history is visible only with a successfully resolved application-core policy.
 * - Live policy changes affect visibility on the next turn and execution checks enforce revocation.
 * - Every returned entry carries Eve's `defineTool` brand required by the runtime lifecycle.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadCurrentExternalGroupCapabilities = vi.hoisted(() => vi.fn());
const authorizeCurrentExternalGroupCapability = vi.hoisted(() => vi.fn());

vi.mock("../image-generation/image-generation-availability.js", () => ({
  IMAGE_GENERATION_AVAILABLE: true,
}));
vi.mock("./external-group-live-policy.js", () => ({
  loadCurrentExternalGroupCapabilities,
  authorizeCurrentExternalGroupCapability,
}));

import capabilities from "../../tools/capabilities.js";
import {
  ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
  FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS,
} from "./group-tool-catalog.js";

const EVE_TOOL_BRAND = Symbol.for("eve:tool-brand");

function resolve(
  attributes: Record<string, unknown> | null,
  initiatorAttributes: Record<string, unknown> | null = null,
  authenticator = "telegram",
) {
  return capabilities.events["step.started"]?.({} as never, {
    channel: { kind: "telegram" },
    messages: [],
    session: {
      auth: {
        current: attributes === null ? null : {
          attributes: {
            telegramActorId: "101",
            telegramActorKind: "telegram_user",
            telegramUserId: "101",
            ...attributes,
          },
          authenticator,
          principalId: "telegram:101",
          principalType: "user",
        },
        initiator: initiatorAttributes === null ? null : {
          attributes: {
            telegramActorId: "101",
            telegramActorKind: "telegram_user",
            telegramUserId: "101",
            ...initiatorAttributes,
          },
          authenticator: "telegram",
          principalId: "telegram:101",
          principalType: "user",
        },
      },
      id: "session-1",
    },
  } as never);
}

describe("dynamic capability resolver", () => {
  beforeEach(() => {
    loadCurrentExternalGroupCapabilities.mockReset();
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set());
  });

  it("resolves tools only at step scope so helper closures are rebuilt before every model call", () => {
    expect(capabilities.events["step.started"]).toBeTypeOf("function");
    expect(capabilities.events["turn.started"]).toBeUndefined();
  });

  it("emits the private surface for a verified private chat", async () => {
    const surface = await resolve({
      memoryScopes: ["personal", "family"],
      telegramChatType: "private",
    });

    expect(Object.keys(surface ?? {})).toContain("export_memory");
    expect(Object.keys(surface ?? {})).not.toContain("list_group_history");
    expect(loadCurrentExternalGroupCapabilities).not.toHaveBeenCalled();
  });

  it("emits the family surface for a registered family group", async () => {
    const surface = await resolve({
      groupType: "family_private",
      memoryScopes: ["family"],
      telegramChatType: "supergroup",
    });

    expect(Object.keys(surface ?? {})).toContain("list_group_history");
    expect(Object.keys(surface ?? {})).not.toContain("export_memory");
  });

  it("emits only granted capabilities and framework denials for an external group", async () => {
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set(["remember"]));

    const surface = await resolve({
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
      memoryScopes: ["group"],
      telegramChatType: "supergroup",
      toolAllowlist: ["remember"],
    });

    expect(Object.keys(surface ?? {}).sort()).toEqual(
      [
        ...ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
        "load_skill",
        "manage_behavior_preference",
        "read_profile_view",
        "remember",
        ...FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS,
      ].sort(),
    );
    expect(loadCurrentExternalGroupCapabilities).toHaveBeenCalledWith({
      familyId: "family-1",
      groupId: "group-1",
    });
  });

  it("emits only snapshot-and-live memory grants for an external background review", async () => {
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set(["remember", "search_memories"]));

    const surface = await resolve({
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
      memoryReviewBatchId: "batch-1",
      memoryReviewMode: "background",
      memoryScopes: ["group"],
      telegramChatType: "supergroup",
      toolAllowlist: ["remember"],
    }, null, "memory-review");

    expect(Object.keys(surface ?? {})).toContain("remember");
    expect(Object.keys(surface ?? {})).not.toContain("search_memories");
    expect(Object.keys(surface ?? {})).toContain("bash");
    expect(loadCurrentExternalGroupCapabilities).toHaveBeenCalledWith({
      familyId: "family-1",
      groupId: "group-1",
    });
    for (const [toolName, definition] of Object.entries(surface ?? {})) {
      expect(
        (definition as unknown as Record<symbol, unknown>)[EVE_TOOL_BRAND],
        `${toolName} review tool must be created through defineTool()`,
      ).toBe(true);
    }
  });

  it("emits load_skill only when the external group has a current skill grant", async () => {
    const surface = await resolve({
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
      memoryScopes: ["group"],
      skillAllowlist: ["pohuy"],
      telegramChatType: "supergroup",
      toolAllowlist: [],
    });

    expect(surface).toHaveProperty("load_skill");
  });

  it("emits imagegen loading only for an interactive live generate_image grant", async () => {
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set(["generate_image"]));
    const attributes = {
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
      memoryScopes: ["group"],
      telegramChatType: "supergroup",
      toolAllowlist: ["generate_image"],
    };

    const interactive = await resolve(attributes);
    const scheduled = await resolve({ ...attributes, scheduledRunId: "run-1" }, attributes);

    expect(interactive?.load_skill?.description).toMatch(/available skill/iu);
    expect(interactive).toHaveProperty("generate_image");
    expect(scheduled?.load_skill?.description).toMatch(/недоступен/iu);
    expect(scheduled).not.toHaveProperty("generate_image");
  });

  it.each([
    ["private", {
      memoryScopes: ["personal", "family"],
      telegramChatType: "private",
    }],
    ["family", {
      groupType: "family_private",
      memoryScopes: ["family"],
      telegramChatType: "supergroup",
    }],
    ["external denied skill", {
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
      memoryScopes: ["group"],
      telegramChatType: "supergroup",
      toolAllowlist: ["remember"],
    }],
    ["external granted skill", {
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
      memoryScopes: ["group"],
      skillAllowlist: ["pohuy"],
      telegramChatType: "supergroup",
      toolAllowlist: ["remember"],
    }],
  ] as const)("returns only Eve-branded tools for %s mode", async (_name, attributes) => {
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set(["remember"]));

    const surface = await resolve(attributes as unknown as Record<string, unknown>);

    expect(Object.keys(surface ?? {}).length).toBeGreaterThan(0);
    for (const [toolName, definition] of Object.entries(surface ?? {})) {
      expect(
        (definition as unknown as Record<symbol, unknown>)[EVE_TOOL_BRAND],
        `${toolName} must be created through defineTool()`,
      ).toBe(true);
    }
  });

  it("revokes a capability that is absent from the current database policy", async () => {
    const surface = await resolve({
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
      memoryScopes: ["group"],
      telegramChatType: "supergroup",
      toolAllowlist: ["remember"],
    });

    expect(Object.keys(surface ?? {})).not.toContain("remember");
  });

  it("emits no application tool when the live policy lookup fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    loadCurrentExternalGroupCapabilities.mockRejectedValue(new Error("database unavailable"));

    const surface = await resolve({
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
      memoryScopes: ["group"],
      telegramChatType: "supergroup",
      toolAllowlist: ["remember"],
    });

    expect(Object.keys(surface ?? {}).sort()).toEqual(
      [
        ...ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
        "load_skill",
        ...FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS,
      ].sort(),
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("AGENT_GROUP_TOOL_POLICY_LOOKUP_FAILED"),
    );
    consoleError.mockRestore();
  });

  it("omits scheduled history when the application-core policy lookup fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    loadCurrentExternalGroupCapabilities.mockRejectedValue(new Error("database unavailable"));

    const attributes = {
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
      memoryScopes: ["group"],
      scheduledGroupHistory: "enabled",
      scheduledRunId: "run-1",
      telegramChatType: "supergroup",
      toolAllowlist: [],
    };
    const surface = await resolve(attributes, attributes);

    expect(surface).not.toHaveProperty("read_scheduled_group_history");
    consoleError.mockRestore();
  });

  it("emits scheduled history after the application-core policy resolves", async () => {
    const attributes = {
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
      memoryScopes: ["group"],
      scheduledGroupHistory: "enabled",
      scheduledRunId: "run-1",
      telegramChatType: "supergroup",
      toolAllowlist: [],
    };
    const surface = await resolve(attributes, attributes);

    expect(surface).toHaveProperty("read_scheduled_group_history");
  });

  it("emits no application tool when the conversation mode cannot be proven", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const surface = await resolve(null);

    expect(Object.keys(surface ?? {}).sort()).toEqual(
      [
        ...ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
        "load_skill",
        ...FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS,
      ].sort(),
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("AGENT_TOOL_SURFACE_ENVIRONMENT_INVALID"),
    );
    consoleError.mockRestore();
  });
});
