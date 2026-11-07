/**
 * The owner's settings door (#459): one small tool in place of six administration tools.
 *
 * Constructs covered:
 * - A call with only a section returns that section's exact contract, as the model would see the tool
 *   itself, changes nothing and asks no confirmation.
 * - A call is checked by the section's own schema first: a malformed one reaches neither the tool nor
 *   a confirmation, and the refusal names the fields; a valid one goes through the tool's own
 *   confirmation and execution with the input the schema produced.
 * - A scheduled run of the owner keeps only the sections it had before: no network access, no keys.
 * - A confirmation card shows the call inside the door; the door's own call stays its identity, and the
 *   section's tool checks its confirmation under that call.
 * - A refusal reaches the model as a bad call to correct, with the form of a call through the door.
 * - The model receives `call` as an open object: a schema that forbade its fields would allow only `{}`.
 */
import { asSchema } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defineTool, type ToolContext } from "../../runtime/tool.js";
import { toModelToolSet } from "../../runtime/turn/model-tools.js";
import { AppError } from "../app-error.js";
import { normalizeModelFacingError } from "../model-facing-error.js";

const groupsApproval = vi.hoisted(() => vi.fn(() => "user-approval" as const));
const groupsExecute = vi.hoisted(() => vi.fn(async (input: unknown, _ctx: unknown) => ({ ran: input })));

vi.mock("../tools/manage_telegram_group.js", async () => {
  const { defineTool: define } = await import("../../runtime/tool.js");
  const { z: zod } = await import("zod");
  return {
    default: define({
      approval: groupsApproval,
      description: "Groups of the family: status, update_policy.",
      execute: groupsExecute,
      inputSchema: zod.object({ action: zod.enum(["status", "update_policy"]), limit: zod.number().int().default(5) }).strict(),
    }),
  };
});

const {
  OWNER_SETTINGS_SCHEDULED_SECTIONS,
  OWNER_SETTINGS_SECTIONS,
  createOwnerSettingsTool,
} = await import("../tools/owner_settings.js");
const { ownerSettingsCardAction } = await import("./owner-settings-sections.js");
const manageTelegramGroup = (await import("../tools/manage_telegram_group.js")).default;

const CONTEXT = { callId: "call-1", toolName: "owner_settings" } as unknown as ToolContext;
const door = createOwnerSettingsTool(OWNER_SETTINGS_SECTIONS);

// The schema the provider receives, built by the runtime exactly as for a real turn.
async function sentSchema(tool: typeof door) {
  const set = toModelToolSet([["owner_settings", tool]]);
  return await (set.owner_settings!.inputSchema as { jsonSchema: unknown }).jsonSchema as {
    properties: { call: Record<string, unknown>; section: { enum: string[] } };
  };
}

function approval(toolInput: Record<string, unknown>) {
  return door.approval!({ callId: "call-1", toolInput, toolName: "owner_settings" } as never);
}

describe("owner_settings", () => {
  beforeEach(() => {
    groupsApproval.mockClear();
    groupsExecute.mockClear();
  });

  it("returns a section's exact contract without running or confirming anything", async () => {
    const manual = await door.execute({ section: "groups" }, CONTEXT) as Record<string, unknown>;

    expect(manual).toMatchObject({ description: manageTelegramGroup.description, section: "groups" });
    expect(manual.inputSchema).toEqual(await asSchema(manageTelegramGroup.inputSchema as never).jsonSchema);
    // Section descriptions name each other's tools; the map says which section each one is here.
    expect(manual.names).toMatchObject({ manage_telegram_group: "groups", manage_api_keys: "api_keys" });
    expect(await approval({ section: "groups" })).toBe("not-applicable");
    expect(groupsExecute).not.toHaveBeenCalled();
  });

  it("refuses a malformed call before any confirmation or execution, naming the fields", async () => {
    const malformed = { call: { action: "delete_everything" }, section: "groups" };

    expect(await approval(malformed)).toBe("not-applicable");
    await expect(door.execute(malformed, CONTEXT)).rejects.toMatchObject({
      code: "AGENT_OWNER_SETTINGS_INPUT_INVALID",
      message: expect.stringContaining("action"),
    });
    expect(groupsApproval).not.toHaveBeenCalled();
    expect(groupsExecute).not.toHaveBeenCalled();
  });

  it("goes through the section's own confirmation and execution with the input its schema produced", async () => {
    const call = { call: { action: "update_policy" }, section: "groups" };

    expect(await approval(call)).toBe("user-approval");
    expect(groupsApproval).toHaveBeenCalledWith(expect.objectContaining({
      toolInput: { action: "update_policy", limit: 5 },
      toolName: "manage_telegram_group",
    }));
    await expect(door.execute(call, CONTEXT)).resolves.toEqual({ ran: { action: "update_policy", limit: 5 } });
    // The person confirmed the door's call: the section's tool checks its confirmation under it.
    expect(groupsExecute.mock.calls[0]![1]).toMatchObject({ confirmedCall: { input: call, toolName: "owner_settings" } });
  });

  it("answers a bad call as one to correct and retry, not as a failure of unknown outcome", async () => {
    const malformed = await door.execute({ call: { action: "nope" }, section: "groups" }, CONTEXT).catch((error: unknown) => error);
    const closed = await createOwnerSettingsTool(OWNER_SETTINGS_SCHEDULED_SECTIONS)
      .execute({ section: "api_keys" }, CONTEXT).catch((error: unknown) => error);

    expect(normalizeModelFacingError(malformed as Error, { toolName: "owner_settings" })).toMatchObject({
      contract: { category: "input", retryable: true, sideEffectStatus: "not_started" },
      isExpectedRefusal: true,
    });
    expect(normalizeModelFacingError(closed as Error, { toolName: "owner_settings" })).toMatchObject({
      contract: { category: "authorization", sideEffectStatus: "not_started" },
      isExpectedRefusal: true,
    });
  });

  it("tells the model the form of a call through the door when the section refuses its input", async () => {
    groupsExecute.mockRejectedValueOnce(new AppError("AGENT_GROUP_INPUT_INVALID", "Поле telegramChatId обязательно"));

    const refusal = await door.execute({ call: { action: "status" }, section: "groups" }, CONTEXT).catch((error: unknown) => error);

    expect(normalizeModelFacingError(refusal as Error, { toolName: "owner_settings" }).contract).toMatchObject({
      category: "input",
      code: "AGENT_GROUP_INPUT_INVALID",
      correction: expect.stringContaining('{"section":"groups","call":'),
      reason: expect.stringContaining("telegramChatId"),
    });
  });

  it("sends the model a schema where call is an open object", async () => {
    const sent = await sentSchema(door);
    expect(sent.properties.call).not.toHaveProperty("additionalProperties", false);
    expect(sent.properties.call).toMatchObject({ type: "object" });
  });

  it("names every section in a small schema, and a scheduled run only the ones it kept", async () => {
    const sections = async (tool: typeof door) => (await sentSchema(tool)).properties.section.enum;
    expect(await sections(door)).toEqual([...OWNER_SETTINGS_SECTIONS]);

    const scheduled = createOwnerSettingsTool(OWNER_SETTINGS_SCHEDULED_SECTIONS);
    expect(OWNER_SETTINGS_SCHEDULED_SECTIONS).toEqual(["groups", "group_schedules", "invitations", "guests", "group_profiles"]);
    expect(await sections(scheduled)).toEqual(["groups", "group_schedules", "invitations", "guests", "group_profiles"]);
    await expect(scheduled.execute({ section: "network" }, CONTEXT)).rejects.toMatchObject({ code: "AGENT_OWNER_SETTINGS_SECTION_FORBIDDEN" });
    await expect(door.execute({ section: "everything" }, CONTEXT)).rejects.toMatchObject({ code: "AGENT_OWNER_SETTINGS_INPUT_INVALID" });
  });

  it("shows a confirmation card for the call inside the door", () => {
    const action = {
      callId: "call-1",
      input: { call: { action: "update_policy" }, section: "groups" },
      kind: "tool-call" as const,
      toolName: "owner_settings",
    };

    expect(ownerSettingsCardAction(action)).toEqual({ ...action, input: { action: "update_policy" }, toolName: "manage_telegram_group" });
    const other = { ...action, toolName: "execute_google_workspace" };
    expect(ownerSettingsCardAction(other)).toBe(other);
  });

  it("is a tool definition the runtime can hand to the model", () => {
    expect(defineTool(door).description).toMatch(/owner_settings|section/u);
    expect(door.replaySafe).not.toBe(true);
  });
});
