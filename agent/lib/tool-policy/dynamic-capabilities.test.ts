/**
 * Dynamic capability resolver tests.
 *
 * Constructs covered:
 * - `capabilities`: one step-scoped map per verified mode instead of replayed helper closures.
 * - An unresolvable mode or failed policy lookup retains only fail-closed baseline wrappers.
 * - Scheduled history is visible only with a successfully resolved application-core policy.
 * - Live policy changes affect visibility on the next turn and execution checks enforce revocation.
 * - Every returned entry is a complete tool: description, input schema and executor.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadCurrentExternalGroupCapabilities = vi.hoisted(() => vi.fn());
const authorizeCurrentExternalGroupCapability = vi.hoisted(() => vi.fn());
const loadGroupSkillAllowlist = vi.hoisted(() => vi.fn());

vi.mock("../group-skills/group-skill-repository.js", () => ({
  groupSkillPolicyRepository: { loadGroupSkillAllowlist },
}));
vi.mock("./external-group-live-policy.js", () => ({
  loadCurrentExternalGroupCapabilities,
  authorizeCurrentExternalGroupCapability,
}));

import { resolveToolSurface } from "../../tools/capabilities.js";
import {
  ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
  EXTERNAL_GROUP_BASE_TOOLS,
} from "./group-tool-catalog.js";

// The runtime hands every surface entry to the model loop, so each must be a complete tool.
function expectRuntimeTool(toolName: string, definition: unknown) {
  const tool = definition as { description?: unknown; execute?: unknown; inputSchema?: unknown };
  expect(typeof tool.description === "string" && tool.description.length > 0, `${toolName} has no description`).toBe(true);
  expect(tool.inputSchema, `${toolName} has no input schema`).toBeTypeOf("object");
  expect(tool.execute, `${toolName} has no executor`).toBeTypeOf("function");
}

function resolve(
  attributes: Record<string, unknown> | null,
  initiatorAttributes: Record<string, unknown> | null = null,
  authenticator = "telegram",
) {
  return resolveToolSurface({
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
    loadGroupSkillAllowlist.mockReset();
    loadGroupSkillAllowlist.mockResolvedValue(new Set());
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

  it("emits only granted capabilities for an external group, without questions or Bash", async () => {
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
        "agent",
        // Attachments are baseline access; image inspection needs a model that sees images.
        "import_telegram_attachment",
        "list_reminders",
        "manage_behavior_preference",
        "manage_reminder",
        "read_profile_view",
        "remember",
        "send_location",
        "send_poll",
        ...EXTERNAL_GROUP_BASE_TOOLS.map((tool) => tool.name),
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
    expect(Object.keys(surface ?? {})).not.toContain("bash");
    expect(loadCurrentExternalGroupCapabilities).toHaveBeenCalledWith({
      familyId: "family-1",
      groupId: "group-1",
    });
    for (const [toolName, definition] of Object.entries(surface ?? {})) expectRuntimeTool(toolName, definition);
  });

  it("always emits load_skill in an external group without reading its skill list", async () => {
    const attributes = {
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
      memoryScopes: ["group"],
      skillAllowlist: [],
      telegramChatType: "supergroup",
      toolAllowlist: [],
    };
    loadGroupSkillAllowlist.mockRejectedValue(new Error("database unavailable"));

    // Which skills load is decided when one is loaded; the descriptor does not depend on the list.
    const surface = await resolve(attributes);
    expect(surface).toHaveProperty("load_skill");
    expect(surface).toHaveProperty("web_search");
    expect(loadGroupSkillAllowlist).not.toHaveBeenCalled();
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
      skillAllowlist: ["behavior-preferences"],
      telegramChatType: "supergroup",
      toolAllowlist: ["remember"],
    }],
  ] as const)("returns only complete runtime tools for %s mode", async (_name, attributes) => {
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set(["remember"]));

    const surface = await resolve(attributes as unknown as Record<string, unknown>);

    expect(Object.keys(surface ?? {}).length).toBeGreaterThan(0);
    for (const [toolName, definition] of Object.entries(surface ?? {})) expectRuntimeTool(toolName, definition);
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
      ].sort(),
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("AGENT_TOOL_SURFACE_ENVIRONMENT_INVALID"),
    );
    consoleError.mockRestore();
  });
});
