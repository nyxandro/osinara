/**
 * The call examples of the multi-action tools stay valid calls.
 *
 * Constructs covered:
 * - Every concrete example passes the tool's own input check: the call stops only at authorization.
 * - An invalid call reaches the tool's own check, which answers with an example, instead of ending
 *   the turn in the approval step or reading as a person's denial there.
 */
import { describe, expect, it } from "vitest";

import { AppError } from "./app-error.js";
import { ModelFacingError } from "./model-facing-error.js";
import { EXTERNAL_GROUP_REMINDER_CALL_EXAMPLES, EXTERNAL_GROUP_REMINDER_TOOLS } from "./tool-policy/external-group-reminder-tools.js";
import manageAgentSchedule, { MANAGE_AGENT_SCHEDULE_CALL_EXAMPLES } from "./tools/manage_agent_schedule.js";
import manageExternalGroupSchedule, { MANAGE_EXTERNAL_GROUP_SCHEDULE_CALL_EXAMPLES } from "./tools/manage_external_group_schedule.js";
import manageFamilyInvitation, { MANAGE_FAMILY_INVITATION_CALL_EXAMPLES } from "./tools/manage_family_invitation.js";
import manageReminder, { MANAGE_REMINDER_CALL_EXAMPLES } from "./tools/manage_reminder.js";
import manageTelegramGroup, { MANAGE_TELEGRAM_GROUP_CALL_EXAMPLES } from "./tools/manage_telegram_group.js";
import notificationSettings, { NOTIFICATION_SETTINGS_CALL_EXAMPLES } from "./tools/notification_settings.js";

type Tool = { approval?: (input: never) => unknown; execute: (input: unknown, ctx: never) => Promise<unknown> };

const NO_AUTH = { callId: "call-1", session: { auth: { current: null, initiator: null }, id: "session-1", turn: { id: "turn-1" } } };

function isInputRefusal(error: unknown): boolean {
  if (error instanceof ModelFacingError) return error.contract.category === "input";
  return error instanceof AppError && error.code.endsWith("_INPUT_INVALID");
}

async function failureOf(tool: Tool, input: unknown): Promise<unknown> {
  return await tool.execute(input, NO_AUTH as never).then(() => null, (error: unknown) => error);
}

const CONCRETE: ReadonlyArray<readonly [string, Tool, Record<string, unknown>]> = [
  ["manage_reminder create", manageReminder as Tool, MANAGE_REMINDER_CALL_EXAMPLES.create!],
  ["group manage_reminder create", EXTERNAL_GROUP_REMINDER_TOOLS.manage_reminder as Tool, EXTERNAL_GROUP_REMINDER_CALL_EXAMPLES.create!],
  ["manage_agent_schedule create isolated", manageAgentSchedule as Tool, (MANAGE_AGENT_SCHEDULE_CALL_EXAMPLES.create as Record<string, Record<string, unknown>>).isolated!],
  ["manage_agent_schedule create conversation", manageAgentSchedule as Tool, (MANAGE_AGENT_SCHEDULE_CALL_EXAMPLES.create as Record<string, Record<string, unknown>>).conversation!],
  ["manage_telegram_group status", manageTelegramGroup as Tool, MANAGE_TELEGRAM_GROUP_CALL_EXAMPLES.status!],
  ["manage_telegram_group register", manageTelegramGroup as Tool, MANAGE_TELEGRAM_GROUP_CALL_EXAMPLES.register!],
  ["manage_external_group_schedule create", manageExternalGroupSchedule as Tool, MANAGE_EXTERNAL_GROUP_SCHEDULE_CALL_EXAMPLES.create!],
  ["manage_family_invitation create", manageFamilyInvitation as Tool, MANAGE_FAMILY_INVITATION_CALL_EXAMPLES.create!],
  ["notification_settings get", notificationSettings as Tool, NOTIFICATION_SETTINGS_CALL_EXAMPLES.get!],
  ["notification_settings set", notificationSettings as Tool, NOTIFICATION_SETTINGS_CALL_EXAMPLES.set!],
];

describe("call examples of multi-action tools", () => {
  it.each(CONCRETE)("%s passes the tool's own input check", async (_label, tool, example) => {
    const error = await failureOf(tool, example);

    expect(error).not.toBeNull();
    expect(isInputRefusal(error), String(error)).toBe(false);
  });

  it.each([
    ["manage_reminder", manageReminder as Tool],
    ["group manage_reminder", EXTERNAL_GROUP_REMINDER_TOOLS.manage_reminder as Tool],
    ["manage_agent_schedule", manageAgentSchedule as Tool],
    ["manage_telegram_group", manageTelegramGroup as Tool],
    ["manage_external_group_schedule", manageExternalGroupSchedule as Tool],
    ["manage_family_invitation", manageFamilyInvitation as Tool],
    ["notification_settings", notificationSettings as Tool],
  ])("%s answers an invalid call with an example", async (_label, tool) => {
    const error = await failureOf(tool, { action: "create_everything" });

    expect(error).toBeInstanceOf(ModelFacingError);
    expect((error as ModelFacingError).contract.example).toBeDefined();
  });

  it.each([
    ["manage_telegram_group", manageTelegramGroup as Tool],
    ["manage_external_group_schedule", manageExternalGroupSchedule as Tool],
    ["manage_family_invitation", manageFamilyInvitation as Tool],
  ])("%s lets an invalid call through its approval step to the input check", async (_label, tool) => {
    expect(await tool.approval!({ toolInput: { action: "approve" } } as never)).toBe("not-applicable");
  });
});
