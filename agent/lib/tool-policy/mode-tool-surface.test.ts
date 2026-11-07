/**
 * Mode-scoped tool surface tests.
 *
 * Constructs covered:
 * - Each trust zone emits exactly its own application tools and nothing from another zone.
 * - An external group emits guarded file tools, granted capabilities, and framework denials.
 * - Granted capabilities re-check the live policy at execution and stay action-level for memory.
 * - HITL approval configuration survives dynamic emission.
 * - Native subagents stay unavailable externally and cannot make root-owned durable-memory decisions.
 * - A subagent gets an explicit list of research and sandbox tools, never the root's administration;
 *   a tool it may only read from comes with its reading actions alone (#457).
 * - A list is an action of the tool that changes the same object; an external group gets each
 *   memory action by its own stored right.
 */
import type { SessionAuth } from "../../runtime/context.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const loadCurrentExternalGroupCapabilities = vi.hoisted(() => vi.fn());
const authorizeCurrentExternalGroupCapability = vi.hoisted(() => vi.fn());
const materializeTelegramAttachment = vi.hoisted(() => vi.fn());

// These cases exercise image inspection, so they state a vision model rather than inheriting the
// checked-in provider config.
vi.mock("../model-vision-availability.js", () => ({
  MODEL_VISION_AVAILABLE: true,
}));

vi.mock("./external-group-live-policy.js", () => ({
  loadCurrentExternalGroupCapabilities,
  authorizeCurrentExternalGroupCapability,
}));

vi.mock("../attachments/telegram-attachment-materializer.js", () => ({ materializeTelegramAttachment }));

import { FAMILY_ONLY_TOOL_NAMES, OWNER_ONLY_TOOL_NAMES, PRIVATE_ONLY_TOOL_NAMES, TRUSTED_MODE_TOOL_NAMES, buildModeToolSurface, buildSubagentToolSurface } from "./mode-tool-surface.js";
import { agentTool } from "../../runtime/tools/delegate.js";
import { isGroupIdDisconnected } from "../group-connection/group-connection-repository.js";
import { bash as nativeBash, glob as nativeGlob, grep as nativeGrep, readFile as nativeReadFile, writeFile as nativeWriteFile } from "../../runtime/tools/defaults.js";
import { TURN_INTERJECTION_FRAMEWORK_TOOL_NAMES } from "../turn-interjection/turn-interjection-surface.js";
import { SUBAGENT_TOOL_ACTIONS, SUBAGENT_TOOL_NAMES } from "./subagent-tool-names.js";
import { ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES, EXTERNAL_GROUP_BASE_TOOLS, EXTERNAL_GROUP_TOOL_NAMES, type ExternalGroupToolName } from "./group-tool-catalog.js";

// Group turns ask whether the owner disconnected the group (#465); here every group is connected.
vi.mock("../group-connection/group-connection-repository.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../group-connection/group-connection-repository.js")>(),
  isGroupIdDisconnected: vi.fn(async () => false),
  isTelegramGroupDisconnected: vi.fn(async () => false),
}));

function names(input: Parameters<typeof buildModeToolSurface>[0]): string[] {
  return Object.keys(buildModeToolSurface(input)).sort();
}

// The trusted chats as the owner sees them; a member's private chat is covered by its own case.
const TRUSTED_CHATS = [{ environment: "private", owner: true }, { environment: "family" }] as const;

// Built-ins every trusted turn has that the interjection surface does not wrap.
const UNWRAPPED_BUILT_IN_NAMES = ["agent", "load_skill", "todo"];

function externalAuth(toolAllowlist: readonly string[]): SessionAuth {
  return {
    current: {
      attributes: {
        familyId: "family-1",
        groupId: "group-1",
        groupType: "external",
        role: "external",
        toolAllowlist,
      },
      authenticator: "telegram",
      principalId: "telegram:101",
      principalType: "user",
    },
    initiator: null,
  };
}

describe("trusted mode tool surfaces", () => {
  it("gives a private chat the shared tools plus owner administration only", () => {
    expect(names({ environment: "private", owner: true })).toEqual(
      [...TRUSTED_MODE_TOOL_NAMES, ...PRIVATE_ONLY_TOOL_NAMES, ...OWNER_ONLY_TOOL_NAMES, ...TURN_INTERJECTION_FRAMEWORK_TOOL_NAMES, ...UNWRAPPED_BUILT_IN_NAMES].sort(),
    );
    // The owner's administration is one door to its sections (#459), not six tools.
    expect(names({ environment: "private", owner: true })).toContain("owner_settings");
    for (const name of ["manage_external_group_schedule", "manage_telegram_group", "manage_api_keys"]) {
      expect(names({ environment: "private", owner: true }), name).not.toContain(name);
    }
  });

  it("exposes R3 profile policy and provenance only in the intended trust zones", () => {
    const privateNames = names({ environment: "private", owner: true });
    const familyNames = names({ environment: "family" });
    const externalNames = names({
      capabilities: new Set(),
      environment: "external",
    });

    expect(privateNames).toEqual(
      expect.arrayContaining(["get_memory_source", "manage_memory_thread", "owner_settings", "read_profile_view"]),
    );
    expect(familyNames).toEqual(expect.arrayContaining(["manage_memory_thread", "read_profile_view"]));
    expect(familyNames).not.toContain("get_memory_source");
    expect(externalNames).toEqual(expect.arrayContaining(["read_profile_view"]));
  });

  it("offers widgets only in a live private chat with the bot (#468)", () => {
    const widgetTools = ["send_widget", "update_widget"];
    expect(names({ environment: "private", owner: true })).toEqual(expect.arrayContaining(widgetTools));
    expect(names({ environment: "private", owner: false } as never)).toEqual(expect.arrayContaining(widgetTools));
    for (const surface of [
      names({ environment: "family" }),
      names({ capabilities: new Set(), environment: "external" }),
      names({ environment: "private", owner: true, scheduledRun: true }),
    ]) {
      for (const tool of widgetTools) expect(surface).not.toContain(tool);
    }
    for (const tool of widgetTools) expect(SUBAGENT_TOOL_NAMES.has(tool)).toBe(false);
  });

  it("gives a family group the shared tools plus group history and attachments only", () => {
    expect(names({ environment: "family" })).toEqual(
      [...TRUSTED_MODE_TOOL_NAMES, ...FAMILY_ONLY_TOOL_NAMES, ...TURN_INTERJECTION_FRAMEWORK_TOOL_NAMES, ...UNWRAPPED_BUILT_IN_NAMES].sort(),
    );
    expect(names({ environment: "family" })).not.toContain("manage_external_group_schedule");
  });

  it("exposes the run-bound history reader only to a scheduled external turn", () => {
    const ordinary = names({
      capabilities: new Set(),
      environment: "external",
    });
    const scheduled = names({
      capabilities: new Set(),
      environment: "external",
      scheduledHistory: true,
    } as never);

    expect(ordinary).not.toContain("read_scheduled_group_history");
    expect(scheduled).toContain("read_scheduled_group_history");
    // A scheduled root turn may delegate, as the built-in `agent` tool allows.
    expect(scheduled).toContain("agent");
  });

  it("sends a place or a poll only from a live turn, in every kind of chat", () => {
    const live = [
      names({ environment: "private", owner: true }),
      names({ environment: "family" }),
      names({ capabilities: new Set(), environment: "external" }),
    ];
    const background = [
      names({ environment: "private", owner: true, scheduledRun: true }),
      names({ environment: "family", scheduledRun: true }),
      names({ capabilities: new Set(), environment: "external", scheduledRun: true } as never),
      names({ capabilities: new Set(), environment: "external", includeApplicationCore: false }),
      Object.keys(buildSubagentToolSurface({ environment: "private", owner: true })),
    ];

    for (const surface of live) expect(surface).toEqual(expect.arrayContaining(["send_contact", "send_location", "send_poll"]));
    for (const surface of background) {
      expect(surface).not.toContain("send_contact");
      expect(surface).not.toContain("send_location");
      expect(surface).not.toContain("send_poll");
    }
  });

  it("manages family skills only in an interactive turn of the private chat", () => {
    expect(names({ environment: "private", owner: true })).toContain("manage_skill");
    expect(names({ environment: "private", owner: true, scheduledRun: true })).not.toContain("manage_skill");
    expect(Object.keys(buildSubagentToolSurface({ environment: "private", owner: true }))).not.toContain("manage_skill");
    expect(names({ environment: "family" })).not.toContain("manage_skill");
  });

  it("requests network access and API keys only in an interactive turn of the owner's private chat", () => {
    // A scheduled turn has nobody to confirm, a delegated task reads untrusted pages.
    const sections = (surface: Record<string, { inputSchema: unknown }>) => {
      const door = surface.owner_settings;
      if (door === undefined) return [];
      return (door.inputSchema as { properties: { section: { enum: string[] } } }).properties.section.enum;
    };
    expect(sections(buildModeToolSurface({ environment: "private", owner: true }))).toEqual(
      ["groups", "group_schedules", "invitations", "guests", "group_profiles", "network", "api_keys"],
    );
    expect(sections(buildModeToolSurface({ environment: "private", owner: true, scheduledRun: true }))).toEqual(
      ["groups", "group_schedules", "invitations", "guests", "group_profiles"],
    );
    expect(buildSubagentToolSurface({ environment: "private", owner: true })).not.toHaveProperty("owner_settings");
    expect(names({ environment: "family" })).not.toContain("owner_settings");
  });

  it("never exposes another zone's tools", () => {
    const privateNames = names({ environment: "private", owner: true });
    const familyNames = names({ environment: "family" });

    for (const familyOnly of FAMILY_ONLY_TOOL_NAMES) {
      expect(privateNames, `private must not expose ${familyOnly}`).not.toContain(familyOnly);
    }
    for (const privateOnly of [...PRIVATE_ONLY_TOOL_NAMES, ...OWNER_ONLY_TOOL_NAMES]) {
      expect(familyNames, `family must not expose ${privateOnly}`).not.toContain(privateOnly);
    }
  });

  it("gives another family member's private chat no owner administration, interactive or scheduled", () => {
    for (const scheduledRun of [false, true]) {
      const member = names({ environment: "private", owner: false, scheduledRun });
      for (const name of OWNER_ONLY_TOOL_NAMES) expect(member, `${name} scheduled=${scheduledRun}`).not.toContain(name);
    }
    expect(names({ environment: "private", owner: false })).toEqual(
      [...TRUSTED_MODE_TOOL_NAMES, ...PRIVATE_ONLY_TOOL_NAMES, ...TURN_INTERJECTION_FRAMEWORK_TOOL_NAMES, ...UNWRAPPED_BUILT_IN_NAMES].sort(),
    );
    // The owner's tool set reaches the model in the same order as before the split.
    const owner = Object.keys(buildModeToolSurface({ environment: "private", owner: true }));
    const adminOrder = owner.filter((name) => [...PRIVATE_ONLY_TOOL_NAMES, ...OWNER_ONLY_TOOL_NAMES].includes(name));
    expect(adminOrder).toEqual([...adminOrder].sort());
  });

  it("gives trusted zones the always-registered built-ins, and external groups no Bash", () => {
    for (const chat of TRUSTED_CHATS) {
      for (const scheduledRun of [false, true]) {
        expect(names({ ...chat, scheduledRun }), `${chat.environment} scheduled=${scheduledRun}`).toEqual(expect.arrayContaining([
          "bash", "load_skill", "read_file", "todo", "write_file",
        ]));
      }
    }
    const external = names({ capabilities: new Set(), environment: "external" });
    expect(external).not.toContain("bash");
  });

  it("re-emits native sandbox tools unchanged in interactive trusted zones only", () => {
    const native = { bash: nativeBash, glob: nativeGlob, grep: nativeGrep, read_file: nativeReadFile, write_file: nativeWriteFile };
    for (const chat of TRUSTED_CHATS) {
      const environment = chat.environment;
      const surface = buildModeToolSurface(chat);
      for (const [name, definition] of Object.entries(native)) {
        expect(surface[name]?.description, `${environment}.${name}`).toBe(definition.description);
        expect(surface[name]?.inputSchema, `${environment}.${name}`).toBe(definition.inputSchema);
      }
      // A scheduled turn keeps the plain built-ins, as the runtime registers them, and no opt-in search tools.
      const scheduled = buildModeToolSurface({ ...chat, scheduledRun: true });
      for (const name of ["bash", "read_file", "write_file"] as const) expect(scheduled[name], `${environment}.${name}`).toBe(native[name]);
      for (const name of ["glob", "grep"]) expect(scheduled).not.toHaveProperty(name);
    }
  });

  it("keeps HITL approval configuration after dynamic emission", () => {
    const surface = buildModeToolSurface({ environment: "private", owner: true });

    for (const toolName of ["execute_google_workspace", "owner_settings"]) {
      expect((surface[toolName] as unknown as { approval?: unknown }).approval, `${toolName} must keep its approval policy`).toBeDefined();
    }
  });

  it("keeps root-owned durable writes off subagents", () => {
    expect(buildModeToolSurface({ environment: "private", owner: true })).toHaveProperty("remember");
    expect(buildSubagentToolSurface({ environment: "private", owner: true })).not.toHaveProperty("remember");
    expect(buildModeToolSurface({ environment: "private", owner: true })).toHaveProperty("manage_behavior_preference");
    expect(buildSubagentToolSurface({ environment: "private", owner: true })).not.toHaveProperty("manage_behavior_preference");
    expect(
      buildSubagentToolSurface({
        capabilities: new Set(["remember"]),
        environment: "external",
      }),
    ).not.toHaveProperty("remember");
    expect(buildModeToolSurface({ environment: "private", owner: true, scheduledRun: true })).not.toHaveProperty("manage_behavior_preference");
    expect(buildModeToolSurface({ environment: "private", owner: true, scheduledRun: true })).not.toHaveProperty("remember");
    expect(
      buildModeToolSurface({
        capabilities: new Set(["remember"]),
        environment: "external",
        scheduledRun: true,
      }),
    ).not.toHaveProperty("remember");
  });
});

describe("subagent tool surface", () => {
  const subagentSurfaces = () => ({
    external: buildSubagentToolSurface({
      capabilities: new Set(EXTERNAL_GROUP_TOOL_NAMES),
      environment: "external",
    }),
    family: buildSubagentToolSurface({ environment: "family" }),
    private: buildSubagentToolSurface({ environment: "private", owner: true }),
  });

  it("gives a delegated task in a private chat exactly the research and sandbox tools", () => {
    // Pinned by name, so widening the subagent list is a decision a reviewer sees in this test.
    expect(Object.keys(subagentSurfaces().private).sort()).toEqual([
      "bash", "execute_google_workspace", "get_current_time", "get_memory_source", "glob",
      "grep", "inspect_workspace_image", "list_proactive_deliveries", "load_skill", "manage_agent_schedule",
      "manage_memory", "manage_memory_thread", "read_file", "read_profile_view",
      "search_memories", "todo", "web_fetch", "web_search", "write_file",
    ]);
    for (const [zone, surface] of Object.entries(subagentSurfaces())) {
      expect(Object.keys(surface).filter((name) => !SUBAGENT_TOOL_NAMES.has(name) && !Object.hasOwn(SUBAGENT_TOOL_ACTIONS, name)), zone)
        .toEqual([]);
    }
  });

  it("keeps the root's administration and outward actions off a delegated task", () => {
    // A child mostly reads untrusted pages; text there must not be able to set up a daily scenario,
    // edit memory, reset the conversation or post into the chat in the person's name.
    const { external, family, private: personal } = subagentSurfaces();
    for (const name of [
      "export_memory", "manage_gmail_message", "manage_google_workspace_connection", "notification_settings",
      "owner_settings", "start_new_context",
    ]) {
      expect(buildModeToolSurface({ environment: "private", owner: true }), `root ${name}`).toHaveProperty(name);
      expect(personal, name).not.toHaveProperty(name);
    }
    expect(external).not.toHaveProperty("remove_group_file");
  });

  it("lets a delegated task only read schedules, memory records and threads", async () => {
    const { external, family, private: personal } = subagentSurfaces();
    const changes = {
      manage_agent_schedule: { action: "delete", id: "00000000-0000-4000-8000-000000000001" },
      manage_memory: { action: "delete", memoryRef: "mem_0123456789abcdef0123456789abcdef" },
      manage_memory_thread: { action: "reactivate", threadRef: "thread_0123456789abcdef0123456789abcdef" },
    } as const;
    const reading = { manage_agent_schedule: "list", manage_memory: "list", manage_memory_thread: "read" } as const;
    for (const [zone, surface] of Object.entries({ family, private: personal })) {
      for (const [name, change] of Object.entries(changes)) {
        const tool = surface[name]!;
        const schema = tool.inputSchema as z.ZodType;
        expect(schema.safeParse(change).success, `${zone} ${name}`).toBe(false);
        expect(schema.safeParse({ action: reading[name as keyof typeof reading], threadRef: "thread_0123456789abcdef0123456789abcdef" }).success
          || schema.safeParse({ action: reading[name as keyof typeof reading] }).success, `${zone} ${name}`).toBe(true);
        expect(tool.description, `${zone} ${name}`).toMatch(/can only be read/u);
        await expect(tool.execute(change as never, { session: { auth: externalAuth([]) } } as never), `${zone} ${name}`)
          .rejects.toMatchObject({ code: "AGENT_TOOL_ACTION_FORBIDDEN" });
      }
    }
    for (const name of ["manage_memory", "manage_memory_thread"] as const) {
      const schema = external[name]!.inputSchema as z.ZodType;
      expect(schema.safeParse(changes[name]).success, `external ${name}`).toBe(false);
    }
    expect((external.manage_memory_thread!.inputSchema as z.ZodType).safeParse({ action: "search", query: "проект" }).success).toBe(true);
  });

  it("keeps the tools a delegated research or document task works with", () => {
    const { external, family, private: personal } = subagentSurfaces();
    for (const name of [
      "bash", "execute_google_workspace", "get_current_time", "glob", "grep",
      "load_skill", "manage_memory", "manage_memory_thread", "read_file", "search_memories", "todo",
      "web_fetch", "web_search", "write_file",
    ]) {
      expect(personal, name).toHaveProperty(name);
    }
    expect(family).toHaveProperty("list_group_history");
    for (const name of ["bash", "read_file", "search_memories", "web_fetch", "web_search"]) {
      expect(external, name).toHaveProperty(name);
    }
  });
});

describe("external group tool surface", () => {
  beforeEach(() => {
    loadCurrentExternalGroupCapabilities.mockReset();
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set());
    authorizeCurrentExternalGroupCapability.mockReset();
    authorizeCurrentExternalGroupCapability.mockImplementation(async (identity, capability) => {
      const allowed = await loadCurrentExternalGroupCapabilities(identity);
      if (!allowed.has(capability)) throw new Error("AGENT_GROUP_TOOL_FORBIDDEN");
    });
  });

  it("emits only guarded baseline tools without a grant", () => {
    expect(names({ capabilities: new Set(), environment: "external" })).toEqual(
      [...ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES, ...EXTERNAL_GROUP_BASE_TOOLS.map((tool) => tool.name), "agent", "import_telegram_attachment", "inspect_workspace_image", "load_skill", "manage_behavior_preference", "manage_reminder", "read_profile_view", "send_contact", "send_location", "send_poll"].sort(),
    );
  });

  it("gives every interactive external group its own reminder tools without a grant", () => {
    const emitted = names({ capabilities: new Set(), environment: "external" });

    expect(emitted).toContain("manage_reminder");
    expect(emitted).not.toContain("list_reminders");
  });

  it("withholds reminder tools from a scheduled run and a channel-authored turn", () => {
    const scheduled = names({
      capabilities: new Set(),
      environment: "external",
      scheduledRun: true,
    });
    const channelAuthored = names({
      capabilities: new Set(),
      environment: "external",
      includeApplicationCore: false,
    });

    for (const emitted of [scheduled, channelAuthored]) {
      expect(emitted).not.toContain("manage_reminder");
    }
  });

  it("gives an interactive external group the runtime's own delegation tool, checked only for disconnection", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(),
      environment: "external",
    });

    // Its own model-facing errors stay; only a disconnected group stops it before a paid sub-task (#465).
    expect(surface.agent!.description).toBe(agentTool.description);
    expect(surface.agent!.inputSchema).toBe(agentTool.inputSchema);
    vi.mocked(isGroupIdDisconnected).mockResolvedValueOnce(true);
    await expect(surface.agent!.execute({}, { session: { auth: { current: { attributes: { groupId: "group-1" } } } } } as never))
      .rejects.toMatchObject({ code: "AGENT_GROUP_DISCONNECTED" });
    expect(buildSubagentToolSurface({ capabilities: new Set(), environment: "external" })).not.toHaveProperty("agent");
  });

  it("always offers load_skill in an external group, whatever its skill list", () => {
    const interactive = buildModeToolSurface({ capabilities: new Set(), environment: "external" });
    const withoutCore = buildModeToolSurface({ capabilities: new Set(), environment: "external", includeApplicationCore: false });
    const scheduled = buildModeToolSurface({ capabilities: new Set(), environment: "external", scheduledRun: true });

    expect(interactive.load_skill!.description).toMatch(/available skill/iu);
    expect(withoutCore).toHaveProperty("load_skill");
    expect(scheduled).toHaveProperty("load_skill");
  });

  it("overrides native workspace file tools only in the external group surface", () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(),
      environment: "external",
    });

    for (const nativeTool of ["glob", "grep", "read_file", "write_file"] as const) {
      expect(surface).toHaveProperty(nativeTool);
      // Trusted zones keep the framework's own tool; only the external group gets a guarded one.
      for (const chat of TRUSTED_CHATS) {
        expect(buildModeToolSurface(chat)[nativeTool]?.description)
          .not.toBe(surface[nativeTool]!.description);
      }
    }
    expect(surface).not.toHaveProperty("bash");
  });

  it("emits no application tool outside the effective allowlist", () => {
    const applicationNames = new Set([...TRUSTED_MODE_TOOL_NAMES, ...PRIVATE_ONLY_TOOL_NAMES, ...OWNER_ONLY_TOOL_NAMES, ...FAMILY_ONLY_TOOL_NAMES]);
    const grantable = new Set<string>([...EXTERNAL_GROUP_TOOL_NAMES.map((name) => name.replace(/\..*$/u, ""))]);
    const alwaysExternal = new Set(["manage_behavior_preference", "manage_reminder", "read_profile_view", "send_contact", "send_location", "send_poll", ...EXTERNAL_GROUP_BASE_TOOLS.map((tool) => tool.name)]);

    for (const emitted of names({
      capabilities: new Set(),
      environment: "external",
    })) {
      expect(applicationNames.has(emitted) && !grantable.has(emitted) && !alwaysExternal.has(emitted)).toBe(false);
    }
  });

  it("emits a granted capability alongside baseline application web search", () => {
    expect(
      names({
        capabilities: new Set(["remember"]),
        environment: "external",
      }),
    ).toContain("remember");
    expect(names({ capabilities: new Set(), environment: "external" })).toContain("web_search");
    expect(
      names({
        capabilities: new Set(["web_fetch"]),
        environment: "external",
      }),
    ).toContain("web_fetch");
  });

  it("surfaces constrained group file removal only when explicitly allowed", () => {
    expect(names({ capabilities: new Set(), environment: "external" })).not.toContain("remove_group_file");
    expect(
      names({
        capabilities: new Set(["remove_group_file"]),
        environment: "external",
      }),
    ).toContain("remove_group_file");
  });

  it("gives every external group images and attachments without a grant", () => {
    for (const capabilities of [new Set<ExternalGroupToolName>(), new Set<ExternalGroupToolName>(["inspect_workspace_image", "import_telegram_attachment"])]) {
      expect(names({ capabilities, environment: "external" })).toEqual(expect.arrayContaining(["import_telegram_attachment", "inspect_workspace_image"]));
    }
    // A channel-authored turn keeps its text-only surface.
    expect(names({ capabilities: new Set(), environment: "external", includeApplicationCore: false }))
      .not.toContain("import_telegram_attachment");
  });

  it("keeps external tool descriptions free of artificial punctuation", () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(EXTERNAL_GROUP_TOOL_NAMES),
      environment: "external",
    });
    const descriptions = Object.values(surface)
      .map(({ description }) => description)
      .join("\n");

    expect(descriptions).not.toMatch(/[—–«»]/u);
  });

  it("imports an attachment without consulting the group's grants", async () => {
    const surface = buildModeToolSurface({ capabilities: new Set(), environment: "external" });

    materializeTelegramAttachment.mockResolvedValueOnce({ mediaType: "text/plain", path: "inbox/42/notes.txt", scope: "group", telegramMessageId: "42" });

    const auth = externalAuth([]);
    const groupAuth = { ...auth, current: { ...auth.current!, attributes: { ...auth.current!.attributes, telegramChatType: "supergroup" } } };

    // The import itself authorizes the group scope and the reference live; a grant is not asked for.
    await expect(surface.import_telegram_attachment!.execute(
      { attachmentId: "00000000-0000-4000-8000-000000000099" },
      { session: { auth: groupAuth } } as never,
    )).resolves.toMatchObject({ path: "/workspace/group/inbox/42/notes.txt" });
    expect(materializeTelegramAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: "group-1", groupType: "external" }),
      "00000000-0000-4000-8000-000000000099",
    );
    expect(loadCurrentExternalGroupCapabilities).not.toHaveBeenCalled();
  });

  it("offers Bash to an external group only with its grant", () => {
    const ungranted = buildModeToolSurface({ capabilities: new Set(), environment: "external" });
    const granted = buildModeToolSurface({ capabilities: new Set(["bash"]), environment: "external" });

    expect(ungranted).not.toHaveProperty("bash");
    expect(granted.bash?.description).toMatch(/isolated environment of the current group/u);
  });

  it("denies a capability revoked after descriptor resolution despite a stale auth grant", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["remember"]),
      environment: "external",
    });
    const staleContext = {
      session: { auth: externalAuth(["remember"]) },
    } as never;

    await expect(surface.remember!.execute({}, staleContext)).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/);
    expect(loadCurrentExternalGroupCapabilities).toHaveBeenCalledWith({
      familyId: "family-1",
      groupId: "group-1",
    });
  });

  it.each(["deleted", "retyped"])("denies a descriptor resolved before the group is %s", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["remove_group_file"]),
      environment: "external",
    });
    const staleContext = {
      session: { auth: externalAuth(["remove_group_file"]) },
    } as never;

    // The live repository represents both a missing row and a non-external row as deny-all.
    loadCurrentExternalGroupCapabilities.mockResolvedValueOnce(new Set());

    await expect(surface.remove_group_file!.execute({}, staleContext)).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/);
  });

  it("gives no tool for a persisted grant that became baseline access", () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["send_workspace_file", "web_fetch"]),
      environment: "external",
    });

    // A group file goes inside the answer that shows it; page reading is the baseline tool.
    expect(surface).not.toHaveProperty("send_workspace_file");
    expect(surface).toHaveProperty("web_fetch");
  });

  it("fails closed when execution-time policy lookup fails", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["remember"]),
      environment: "external",
    });
    const staleContext = {
      session: { auth: externalAuth(["remember"]) },
    } as never;
    loadCurrentExternalGroupCapabilities.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(surface.remember!.execute({}, staleContext)).rejects.toMatchObject({
      contract: {
        code: "AGENT_TOOL_DEPENDENCY_FAILED",
        retryable: false,
        sideEffectStatus: "unknown",
      },
    });
  });

  it("enforces action-level capabilities inside manage_memory", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["manage_memory.undo"]),
      environment: "external",
    });
    const context = {
      session: { auth: externalAuth(["manage_memory.undo"]) },
    } as never;
    // The live policy (default: nothing granted now) is checked only for an action of the view.
    expect(surface).toHaveProperty("manage_memory");
    const schema = surface.manage_memory!.inputSchema as z.ZodType;
    expect(schema.safeParse({ action: "undo", memoryRef: "mem_0123456789abcdef0123456789abcdef" }).success)
      .toBe(true);
    expect(schema.safeParse({ action: "delete", memoryRef: "mem_0123456789abcdef0123456789abcdef" }).success)
      .toBe(false);
    expect(surface.manage_memory!.description).toContain('"action":"undo"');
    expect(surface.manage_memory!.description).not.toContain('"action":"edit"');
    expect(surface.manage_memory!.description).not.toContain('"action":"delete"');
    expect(surface.manage_memory!.description).not.toContain('"action":"list"');
    await expect(surface.manage_memory!.execute({ action: "delete", memoryRef: "mem_0123456789abcdef0123456789abcdef" }, context))
      .rejects.toThrowError(/AGENT_TOOL_ACTION_FORBIDDEN/);
    await expect(surface.manage_memory!.execute(
      { action: "undo", memoryRef: "mem_0123456789abcdef0123456789abcdef" },
      { session: { auth: externalAuth([]) } } as never,
    )).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/);
  });

  it("gives each stored memory right its action of a memory tool, and no separate tool", () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["list_memories", "search_memory_threads", "read_memory_thread"]),
      environment: "external",
    });

    for (const name of ["list_memories", "list_memory_threads", "search_memory_threads", "read_memory_thread"]) {
      expect(surface, name).not.toHaveProperty(name);
    }
    const memory = surface.manage_memory!.inputSchema as z.ZodType;
    expect(memory.safeParse({ action: "list" }).success).toBe(true);
    // The group's list never showed earlier versions of its records, and still does not.
    expect(memory.safeParse({ action: "list", history: true }).success).toBe(false);
    expect(surface.manage_memory!.description).not.toMatch(/history|superseded/u);
    expect(memory.safeParse({ action: "edit", content: "x", memoryRef: "mem_0123456789abcdef0123456789abcdef" }).success).toBe(false);
    const threads = surface.manage_memory_thread!.inputSchema as z.ZodType;
    expect(threads.safeParse({ action: "search", query: "проект" }).success).toBe(true);
    expect(threads.safeParse({ action: "read", threadRef: "thread_0123456789abcdef0123456789abcdef" }).success).toBe(true);
    // The group was never granted the list of threads, and stays without it.
    expect(threads.safeParse({ action: "list" }).success).toBe(false);
  });

  it("keeps memory-thread lifecycle action-level and re-checks the live external policy", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["manage_memory_thread.complete"]),
      environment: "external",
    });
    const revoked = { session: { auth: externalAuth([]) } } as never;

    expect(surface).toHaveProperty("manage_memory_thread");
    await expect(
      surface.manage_memory_thread!.execute(
        {
          action: "complete",
          authority: "current_user_statement",
          sourceEntryRefs: ["entry_0123456789abcdef0123456789abcdef"],
          threadRef: "thread_0123456789abcdef0123456789abcdef",
        },
        revoked,
      ),
    ).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/u);
  });

  it("denies every capability when the trusted snapshot is corrupt", () => {
    expect(
      names({
        capabilities: new Set(["unknown_tool"] as unknown as ExternalGroupToolName[]),
        environment: "external",
      }),
    ).toEqual([...ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES, ...EXTERNAL_GROUP_BASE_TOOLS.map((tool) => tool.name), "agent", "import_telegram_attachment", "inspect_workspace_image", "load_skill", "manage_behavior_preference", "manage_reminder", "read_profile_view", "send_contact", "send_location", "send_poll"].sort());
  });

  it("exposes only group scope in external shared-tool schemas and descriptions", () => {
    const external = buildModeToolSurface({
      capabilities: new Set(["inspect_workspace_image", "list_memories", "list_memory_threads", "remember"]),
      environment: "external",
    });

    const inputs = {
      inspect_workspace_image: {
        path: "image.png",
        question: "Что изображено?",
      },
      manage_memory: { action: "list" },
      manage_memory_thread: { action: "list" },
      remember: {
        basis: "agent_inferred",
        content: "Проверка",
        kind: "fact",
        sensitivity: "normal",
        subject: { kind: "current_author" },
      },
    } as const;
    for (const [toolName, input] of Object.entries(inputs)) {
      const tool = external[toolName]!;
      const schema = tool.inputSchema as z.ZodType;
      expect(schema.safeParse({ ...input, scope: "group" }).success, toolName).toBe(true);
      expect(schema.safeParse({ ...input, scope: "personal" }).success, toolName).toBe(false);
      expect(schema.safeParse({ ...input, scope: "family" }).success, toolName).toBe(false);
      expect(tool.description, toolName).not.toMatch(/personal|family/iu);
      expect(tool.description, toolName).toMatch(/group|групп/iu);
    }

    // The external presentation is a separate schema: a participant's avatar must be reachable there too.
    const image = external.inspect_workspace_image!;
    expect((image.inputSchema as z.ZodType).safeParse({
      avatarOfSequence: "880",
      question: "Есть ли на аватарке человек?",
      scope: "group",
    }).success).toBe(true);
    expect(image.description).toMatch(/avatarOfSequence/u);

    const trustedRemember = buildModeToolSurface({
      environment: "private", owner: true,
    }).remember!;
    const trustedSchema = trustedRemember.inputSchema as z.ZodType;
    expect(
      trustedSchema.safeParse({
        basis: "agent_inferred",
        content: "Проверка",
        kind: "fact",
        scope: "personal",
        sensitivity: "normal",
        subject: { kind: "current_author" },
      }).success,
    ).toBe(true);
  });
});
