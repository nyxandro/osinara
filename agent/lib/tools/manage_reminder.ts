/**
 * Consolidated reminder mutation tool.
 *
 * Export:
 * - `manage_reminder`: routes create, update, pause, resume, and delete actions.
 *
 * Key constructs:
 * - Object-shaped model schema avoids root JSON Schema unions in tool descriptors.
 * - Action-specific validators return actionable Russian AppError messages.
 * - Reply buttons are written as Telegram button markup at the end of `content`, as in an answer;
 *   the reminder keeps its text and its buttons apart, and new content brings its own buttons.
 * - Files shown in `content` are checked when it is written, against the chat the reminder reaches:
 *   it goes out later without the model, which could no longer fix them.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import {
  REMINDER_CONTENT_MAX_LENGTH,
  REMINDER_RECURRENCE_INTERVAL_MAX,
} from "../reminders/reminder-config.js";
import { requireReminderAuthorization } from "../reminders/reminder-context.js";
import { reminderWriterRights, requireReminderFiles } from "../reminders/reminder-files.js";
import { REMINDER_RECURRENCE_UNITS, type ReminderRecurrence } from "../reminders/reminder-record.js";
import { reminderRepository } from "../reminders/reminder-repository.js";
import type { ReplyButtonRows } from "../reply-buttons/reply-button-contract.js";
import { readReplyButtonMarkup } from "../reply-buttons/reply-button-markup.js";
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

const INPUT_ERROR_CODE = "AGENT_REMINDER_INPUT_INVALID";
const TOOL_ACTIONS = ["create", "update", "pause", "resume", "delete"] as const;
const SCOPES = ["personal", "family"] as const;
const TOP_LEVEL_FIELDS = [
  "action",
  "content",
  "firstRunAt",
  "id",
  "recurrence",
  "scope",
  "timezone",
] as const;

const recurrenceSchema = z.object({
  interval: z.number().int().min(1).max(REMINDER_RECURRENCE_INTERVAL_MAX),
  unit: z.enum(REMINDER_RECURRENCE_UNITS),
}).strict();

// Room for the button markup of six buttons on top of the text itself.
const REMINDER_BUTTON_MARKUP_MAX_LENGTH = 1_000;
const BUTTON_MARKUP_EXAMPLE =
  "<tg-button-row><tg-button style=\"success\">✅ Оплатил</tg-button><tg-button>⏰ Через час</tg-button></tg-button-row>";

const manageReminderSchema = z.object({
  action: z.enum(TOOL_ACTIONS),
  content: z.string().optional(),
  firstRunAt: z.string().optional(),
  id: z.string().optional(),
  recurrence: z.union([recurrenceSchema, z.null()]).optional(),
  scope: z.enum(SCOPES).optional(),
  timezone: z.string().optional(),
}).strict();

type ReminderAction = (typeof TOOL_ACTIONS)[number];

function requireReminderRecurrence(raw: unknown): ReminderRecurrence | null {
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
    typeof interval !== "number" ||
    !Number.isInteger(interval) ||
    interval < 1 ||
    interval > REMINDER_RECURRENCE_INTERVAL_MAX
  ) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Для recurrence передайте null или объект {\"unit\":\"weekly\",\"interval\":1}",
    );
  }
  return { interval, unit };
}

function optionalReminderRecurrence(raw: unknown): ReminderRecurrence | null | undefined {
  return raw === undefined ? undefined : requireReminderRecurrence(raw);
}

function requireReminderId(input: Record<string, unknown>): string {
  return requiredUuid(input, "id", INPUT_ERROR_CODE, "напоминание из list_reminders");
}

/** The reminder text and the buttons written at its end; refused markup reaches the model. */
function reminderContent(raw: string): { buttons: ReplyButtonRows | null; content: string } {
  const reading = readReplyButtonMarkup(raw);
  if (reading.error !== null) {
    toolInputError(INPUT_ERROR_CODE, `${reading.error.message}. Кнопки пишутся в конце content: ${BUTTON_MARKUP_EXAMPLE}`);
  }
  const content = reading.markdown.trim();
  if (!content) toolInputError(INPUT_ERROR_CODE, "Поле content должно содержать текст напоминания, а не только кнопки");
  if (content.length > REMINDER_CONTENT_MAX_LENGTH) {
    toolInputError(INPUT_ERROR_CODE, `Текст напоминания без кнопок должен быть не длиннее ${REMINDER_CONTENT_MAX_LENGTH} символов`);
  }
  return { buttons: reading.rows, content: reading.rows === null ? raw : content };
}

function contentInput(input: Record<string, unknown>, required: boolean) {
  const options = { maxLength: REMINDER_CONTENT_MAX_LENGTH + REMINDER_BUTTON_MARKUP_MAX_LENGTH };
  const raw = required
    ? requiredString(input, "content", INPUT_ERROR_CODE, "Позвонить врачу", options)
    : optionalString(input, "content", INPUT_ERROR_CODE, "Позвонить врачу", options);
  return raw === undefined ? undefined : reminderContent(raw);
}

function requireCreateInput(input: Record<string, unknown>) {
  requireOnlyFields(input, [
    "action",
    "content",
    "firstRunAt",
    "recurrence",
    "scope",
    "timezone",
  ], "action=create", INPUT_ERROR_CODE);
  const { buttons, content } = contentInput(input, true)!;
  return {
    ...(buttons === null ? {} : { buttons }),
    content,
    firstRunAt: requiredIsoDate(input, "firstRunAt", INPUT_ERROR_CODE),
    recurrence: requireReminderRecurrence(input.recurrence),
    scope: requiredEnum(input, "scope", SCOPES, INPUT_ERROR_CODE) as (typeof SCOPES)[number],
    timezone: requiredString(input, "timezone", INPUT_ERROR_CODE, "Europe/Moscow", { maxLength: 100 }),
  };
}

function requireUpdateInput(input: Record<string, unknown>) {
  requireOnlyFields(input, [
    "action",
    "content",
    "firstRunAt",
    "id",
    "recurrence",
    // MiniMax materializes these known create-only siblings; update ignores them explicitly.
    "scope",
    "timezone",
  ], "action=update", INPUT_ERROR_CODE);
  // New content brings its own buttons or none; without new content the buttons stay.
  const content = contentInput(input, false);
  const firstRunAt = optionalIsoDate(input, "firstRunAt", INPUT_ERROR_CODE);
  const recurrence = optionalReminderRecurrence(input.recurrence);
  if (content === undefined && firstRunAt === undefined && recurrence === undefined) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Для action=update передайте хотя бы одно изменение: content, firstRunAt или recurrence",
    );
  }
  return {
    ...(content === undefined ? {} : content),
    firstRunAt,
    id: requireReminderId(input),
    recurrence,
  };
}

function requireIdOnlyInput(input: Record<string, unknown>, action: ReminderAction): string {
  requireOnlyFields(input, ["action", "id"], `action=${action}`, INPUT_ERROR_CODE);
  return requireReminderId(input);
}

function requireManageReminderInput(input: unknown) {
  const payload = requireInputRecord(input, "manage_reminder", INPUT_ERROR_CODE);
  requireOnlyFields(payload, TOP_LEVEL_FIELDS, "manage_reminder", INPUT_ERROR_CODE);
  const action = requireAction(payload, "manage_reminder", TOOL_ACTIONS, INPUT_ERROR_CODE);

  if (action === "create") return { action, values: requireCreateInput(payload) } as const;
  if (action === "update") return { action, values: requireUpdateInput(payload) } as const;
  return { action, id: requireIdOnlyInput(payload, action) } as const;
}

const TOOL_DESCRIPTION = [
  "Create, change, pause, resume or delete an ordinary reminder: ready-made text the bot sends at the set time without calling the model. Load the schedules skill first: it holds the text and time rules.",
  "Not an agent schedule: for future work with research or a report use manage_agent_schedule.",
  "content is laid out like your answers, Markdown, reply buttons and a workspace file on its own line as ![caption](/workspace/...) included; a file is checked now and read at delivery, so it must stay in place.",
  "Create payload: {\"action\":\"create\",\"content\":\"Позвонить врачу\",\"firstRunAt\":\"2026-08-01T10:00:00+03:00\",\"timezone\":\"Europe/Moscow\",\"scope\":\"personal\",\"recurrence\":null}.",
  "Recurrence: none is recurrence=null; a repeat is {\"unit\":\"daily\",\"interval\":1} with unit minutely, hourly, daily, weekly, monthly or yearly and interval 1-365.",
  "Update passes id and only the changed content, firstRunAt or recurrence (recurrence=null removes the repeat); pause, resume and delete pass only action and id. Take the id from list_reminders and do not delete and re-create a reminder to change it.",
  "firstRunAt is an ISO datetime with a UTC offset, timezone is IANA. A delivered one-time reminder cannot change: create a new one.",
].join(" ");

export default defineTool({
  // Repeating it after a crash is safe: its effect is keyed on the call id.
  replaySafe: true,
  description: TOOL_DESCRIPTION,
  inputSchema: manageReminderSchema,
  async execute(input, ctx) {
    const parsed = requireManageReminderInput(input);
    const authorization = requireReminderAuthorization(ctx);
    if (parsed.action === "create") {
      await requireReminderFiles({
        content: parsed.values.content,
        errorCode: INPUT_ERROR_CODE,
        rights: () => reminderWriterRights(authorization),
        scope: parsed.values.scope,
      });
      return await reminderRepository.create(authorization, {
        ...parsed.values,
        operationKey: ctx.callId,
      });
    }
    if (parsed.action === "update") {
      const { id, ...values } = parsed.values;
      // A reminder that is not found, or a public chat's one this tool may not change, is reported
      // by the update itself.
      const scope = values.content === undefined ? null : await reminderRepository.scopeOf(authorization, id);
      if (values.content !== undefined && scope !== null && scope !== "group") {
        await requireReminderFiles({
          content: values.content, errorCode: INPUT_ERROR_CODE, rights: () => reminderWriterRights(authorization), scope,
        });
      }
      return await reminderRepository.update(authorization, id, {
        ...values,
        operationKey: ctx.callId,
      });
    }
    if (parsed.action === "pause" || parsed.action === "resume") {
      return await reminderRepository.update(authorization, parsed.id, {
        enabled: parsed.action === "resume",
        operationKey: ctx.callId,
      });
    }

    return {
      deleted: await reminderRepository.delete(authorization, parsed.id, ctx.callId),
    };
  },
});
