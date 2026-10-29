/**
 * External-group reminder tools.
 *
 * Export:
 * - `EXTERNAL_GROUP_REMINDER_TOOLS`: same-name `list_reminders` and `manage_reminder` descriptors
 *   bound to the public-chat reminder boundary.
 *
 * Key constructs:
 * - The public chat has exactly one scope and one timezone, so neither is a model input here. A
 *   trusted descriptor keeps its own scope field and stays untouched by this module.
 * - Every execute re-derives the verified Telegram participant and acts only in that chat.
 * - Files shown in `content` are checked when it is written: only this chat's own folder reaches it.
 */
import { defineTool, type ToolDefinition } from "../../runtime/tool.js";
import { z } from "zod";

import { answerWorkspaceAuthorization } from "../answer-files/telegram-answer-files.js";
import { groupReminderRepository } from "../reminders/group-reminder-repository.js";
import { requireGroupReminderAuthorization } from "../reminders/group-reminder-context.js";
import {
  GROUP_REMINDER_MAX_PER_CHAT,
  GROUP_REMINDER_TIMEZONE,
  REMINDER_CONTENT_MAX_LENGTH,
  REMINDER_LIST_DEFAULT_LIMIT,
  REMINDER_LIST_MAX_LIMIT,
  REMINDER_RECURRENCE_INTERVAL_MAX,
} from "../reminders/reminder-config.js";
import { requireReminderFiles } from "../reminders/reminder-files.js";
import { REMINDER_RECURRENCE_UNITS, type ReminderRecurrence } from "../reminders/reminder-record.js";
import {
  optionalIsoDate,
  optionalString,
  requireAction,
  requiredEnum,
  requiredIsoDate,
  requiredString,
  requiredUuid,
  requireInputRecord,
  requireOnlyFields,
  toolInputError,
} from "../tool-input-validation.js";

type AnyToolDefinition = ToolDefinition<any, any>;

const INPUT_ERROR_CODE = "AGENT_REMINDER_INPUT_INVALID";
const TOOL_ACTIONS = ["create", "update", "pause", "resume", "delete"] as const;
const TOP_LEVEL_FIELDS = ["action", "content", "firstRunAt", "id", "recurrence"] as const;
// The chat has one timezone, so the wall clock reported to the human and the instant that is stored
// must be the same reading. A UTC timestamp would silently move the reminder by three hours.
const MOSCOW_OFFSET_SUFFIX = "+03:00";

function requireMoscowOffset(raw: unknown): void {
  if (typeof raw === "string" && !raw.trim().endsWith(MOSCOW_OFFSET_SUFFIX)) {
    toolInputError(
      INPUT_ERROR_CODE,
      `Для firstRunAt указывай московское время со смещением ${MOSCOW_OFFSET_SUFFIX}, ` +
        "например 2026-09-04T18:00:00+03:00",
    );
  }
}

const recurrenceSchema = z.object({
  interval: z.number().int().min(1).max(REMINDER_RECURRENCE_INTERVAL_MAX),
  unit: z.enum(REMINDER_RECURRENCE_UNITS),
}).strict();

const manageReminderSchema = z.object({
  action: z.enum(TOOL_ACTIONS),
  content: z.string().optional(),
  firstRunAt: z.string().optional(),
  id: z.string().optional(),
  recurrence: z.union([recurrenceSchema, z.null()]).optional(),
}).strict();

function requireRecurrence(raw: unknown): ReminderRecurrence | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Для recurrence передайте null или объект {\"unit\":\"weekly\",\"interval\":1}",
    );
  }
  const recurrence = raw as Record<string, unknown>;
  requireOnlyFields(recurrence, ["interval", "unit"], "recurrence", INPUT_ERROR_CODE);
  const unit = requiredEnum(recurrence, "unit", REMINDER_RECURRENCE_UNITS, INPUT_ERROR_CODE);
  const interval = recurrence.interval;
  if (
    typeof interval !== "number" || !Number.isInteger(interval) ||
    interval < 1 || interval > REMINDER_RECURRENCE_INTERVAL_MAX
  ) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Для recurrence передайте null или объект {\"unit\":\"weekly\",\"interval\":1}",
    );
  }
  return { interval, unit };
}

function requireReminderId(input: Record<string, unknown>): string {
  return requiredUuid(input, "id", INPUT_ERROR_CODE, "напоминание из list_reminders");
}

function requireCreateInput(input: Record<string, unknown>) {
  requireOnlyFields(input, ["action", "content", "firstRunAt", "recurrence"], "action=create", INPUT_ERROR_CODE);
  requireMoscowOffset(input.firstRunAt);
  return {
    content: requiredString(input, "content", INPUT_ERROR_CODE, "Созвон в 18:00", {
      maxLength: REMINDER_CONTENT_MAX_LENGTH,
    }),
    firstRunAt: requiredIsoDate(input, "firstRunAt", INPUT_ERROR_CODE),
    recurrence: requireRecurrence(input.recurrence),
  };
}

function requireUpdateInput(input: Record<string, unknown>) {
  requireOnlyFields(input, ["action", "content", "firstRunAt", "id", "recurrence"], "action=update", INPUT_ERROR_CODE);
  const content = optionalString(input, "content", INPUT_ERROR_CODE, "Созвон в 18:00", {
    maxLength: REMINDER_CONTENT_MAX_LENGTH,
  });
  requireMoscowOffset(input.firstRunAt);
  const firstRunAt = optionalIsoDate(input, "firstRunAt", INPUT_ERROR_CODE);
  const recurrence = input.recurrence === undefined ? undefined : requireRecurrence(input.recurrence);
  if (content === undefined && firstRunAt === undefined && recurrence === undefined) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Для action=update передайте хотя бы одно изменение: content, firstRunAt или recurrence",
    );
  }
  return { content, firstRunAt, id: requireReminderId(input), recurrence };
}

function requireIdOnlyInput(input: Record<string, unknown>, action: string): string {
  requireOnlyFields(input, ["action", "id"], `action=${action}`, INPUT_ERROR_CODE);
  return requireReminderId(input);
}

function requireManageInput(input: unknown) {
  const payload = requireInputRecord(input, "manage_reminder", INPUT_ERROR_CODE);
  requireOnlyFields(payload, TOP_LEVEL_FIELDS, "manage_reminder", INPUT_ERROR_CODE);
  const action = requireAction(payload, "manage_reminder", TOOL_ACTIONS, INPUT_ERROR_CODE);

  if (action === "create") return { action, values: requireCreateInput(payload) } as const;
  if (action === "update") return { action, values: requireUpdateInput(payload) } as const;
  return { action, id: requireIdOnlyInput(payload, action) } as const;
}

const MANAGE_DESCRIPTION = [
  "Create, change, pause, resume or delete a reminder of this chat: at the given time the bot itself posts its ready-made text here, without calling the model. Load the group-reminders skill first: it holds the text and time rules.",
  "content is read at the moment of delivery: no words like \"завтра\" or \"через час\", name the event time by the Moscow clock.",
  "<current_time> is UTC and Moscow is always UTC+03:00: count \"через час\" or \"завтра утром\" from it and add three hours for Moscow time.",
  "content is laid out like your answers: Markdown and a file of this chat's folder on its own line as ![caption](/workspace/group/...); a file is checked now and read at delivery, so it must stay in place.",
  `Limit: no more than ${GROUP_REMINDER_MAX_PER_CHAT} active reminders for the whole chat. The chat's timezone is always ${GROUP_REMINDER_TIMEZONE}.`,
  "Create payload: {\"action\":\"create\",\"content\":\"Созвон по проекту\",\"firstRunAt\":\"2026-09-04T18:00:00+03:00\",\"recurrence\":null}.",
  "Recurrence: none is recurrence=null; a repeat is {\"unit\":\"daily\",\"interval\":1} with unit minutely, hourly, daily, weekly, monthly or yearly and interval 1-365.",
  "Update passes id and only the changed content, firstRunAt or recurrence; pause, resume and delete pass only action and id. One call works with exactly one reminder; take its id from list_reminders.",
  `firstRunAt is always an ISO datetime with the Moscow offset ${MOSCOW_OFFSET_SUFFIX}: another offset is rejected. A delivered one-time reminder cannot change: create a new one.`,
].join(" ");

const LIST_DESCRIPTION = [
  "List the active reminders of this chat page by page, nearest first: any participant sees them, including paused ones. Already delivered ones are not shown here.",
  "Use it before a change or deletion to find the record's id by the name the person said.",
  "Result: {items,nextCursor}; if nextCursor is not null, pass it unchanged for the next page.",
].join(" ");

export const EXTERNAL_GROUP_REMINDER_TOOLS: Readonly<Record<string, AnyToolDefinition>> = {
  list_reminders: defineTool({
    description: LIST_DESCRIPTION,
    inputSchema: z.object({
      cursor: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(REMINDER_LIST_MAX_LIMIT).default(REMINDER_LIST_DEFAULT_LIMIT),
    }).strict(),
    async execute(input, ctx) {
      return await groupReminderRepository.list(requireGroupReminderAuthorization(ctx), input);
    },
  }) as unknown as AnyToolDefinition,
  manage_reminder: defineTool({
    description: MANAGE_DESCRIPTION,
    inputSchema: manageReminderSchema,
    async execute(input, ctx) {
      const parsed = requireManageInput(input);
      const authorization = requireGroupReminderAuthorization(ctx);
      if (parsed.action === "create") {
        await requireReminderFiles({
          content: parsed.values.content,
          errorCode: INPUT_ERROR_CODE,
          rights: () => answerWorkspaceAuthorization(ctx.session),
          scope: "group",
        });
        return await groupReminderRepository.create(authorization, {
          ...parsed.values,
          operationKey: ctx.callId,
        });
      }
      if (parsed.action === "update") {
        const { id, ...values } = parsed.values;
        if (values.content !== undefined) {
          await requireReminderFiles({
            content: values.content, errorCode: INPUT_ERROR_CODE, rights: () => answerWorkspaceAuthorization(ctx.session), scope: "group",
          });
        }
        return await groupReminderRepository.update(authorization, id, {
          ...(values.content === undefined ? {} : { content: values.content }),
          ...(values.firstRunAt === undefined ? {} : { firstRunAt: values.firstRunAt }),
          ...(values.recurrence === undefined ? {} : { recurrence: values.recurrence }),
          operationKey: ctx.callId,
        });
      }
      if (parsed.action === "pause" || parsed.action === "resume") {
        return await groupReminderRepository.update(authorization, parsed.id, {
          enabled: parsed.action === "resume",
          operationKey: ctx.callId,
        });
      }

      return {
        deleted: await groupReminderRepository.delete(authorization, parsed.id, ctx.callId),
      };
    },
  }) as unknown as AnyToolDefinition,
};
