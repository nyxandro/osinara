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
 * - A written reminder reports `calendarCopy`: whether it appears in the person's Google Calendar by
 *   itself, or why not, so the model never creates a second event for it.
 * - The first run is named exactly one way (#451): an exact moment with the zone, the clock time the
 *   person said, or a countdown. A clock time without the person's zone becomes a wait that is set
 *   by itself once the zone is saved; changing or cancelling it goes through the same actions.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { calendarCopyOutlook } from "../calendar-mirror/calendar-mirror-outlook.js";
import {
  REMINDER_CONTENT_MAX_LENGTH,
  REMINDER_RECURRENCE_INTERVAL_MAX,
} from "../reminders/reminder-config.js";
import { requireReminderAuthorization } from "../reminders/reminder-context.js";
import { reminderWriterRights, requireReminderContent } from "../reminders/reminder-files.js";
import { REMINDER_RECURRENCE_UNITS, type ReminderRecurrence } from "../reminders/reminder-record.js";
import { createReminderOrWait } from "../reminders/reminder-create.js";
import { reminderRepository } from "../reminders/reminder-repository.js";
import { parseLocalFirstRun, requireCountdownMinutes, type ReminderTimeInput } from "../reminders/reminder-time-input.js";
import { timezoneWaitRepository } from "../reminders/reminder-timezone-wait-repository.js";
import type { ReplyButtonRows } from "../reply-buttons/reply-button-contract.js";
import { readReplyButtonMarkup } from "../reply-buttons/reply-button-markup.js";
import { withCallExamples, type CallExamples } from "../tool-call-examples.js";
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
  "firstRunInMinutes",
  "id",
  "localFirstRun",
  "recurrence",
  "scope",
  "timezone",
] as const;
const TIME_FIELDS = ["firstRunAt", "localFirstRun", "firstRunInMinutes"] as const;
const AWAITING_NEXT_STEP =
  "Not set yet: the person's timezone is unknown. Ask where they are now with the buttons «Да, {suggestedLabel}» and «Другой пояс»; once notification_settings saves their zone, this reminder is set by itself at the clock time they named. Do not say it is set.";
// A zone is saved only in the person's private chat, so a question asked in the group could not be
// answered there: measured 2026-11-04, the generic step above drew zone buttons into the group 4 times of 5.
const AWAITING_NEXT_STEP_IN_GROUP =
  "Not set yet: the author's timezone is unknown, and it can be saved only in their private chat with you. Ask them to write to you privately where they are now; the bot also writes there within a minute. Do not ask for the zone here and do not show zone buttons here. Once the zone is saved, this reminder is set by itself and goes to this group. Do not say it is set.";

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
  firstRunInMinutes: z.number().int().optional(),
  id: z.string().optional(),
  localFirstRun: z.string().optional(),
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

/** Exactly one way of naming the first run; `timezone` belongs only to an exact moment. */
function requireTimeInput(input: Record<string, unknown>): ReminderTimeInput {
  const given = TIME_FIELDS.filter((field) => input[field] !== undefined);
  if (given.length !== 1) {
    toolInputError(
      "AGENT_REMINDER_TIME_INPUT_AMBIGUOUS",
      "Передайте ровно одно из полей: firstRunAt с timezone, localFirstRun или firstRunInMinutes",
    );
  }
  const stated = input.timezone === undefined
    ? {}
    : { statedTimezone: requiredString(input, "timezone", INPUT_ERROR_CODE, "Europe/Moscow", { maxLength: 100 }) };
  if (given[0] === "localFirstRun") {
    return { kind: "local", local: parseLocalFirstRun(requiredString(input, "localFirstRun", INPUT_ERROR_CODE, "2026-08-01T10:00")), ...stated };
  }
  if (given[0] === "firstRunInMinutes") return { kind: "countdown", minutes: requireCountdownMinutes(input.firstRunInMinutes), ...stated };
  return {
    at: requiredIsoDate(input, "firstRunAt", INPUT_ERROR_CODE),
    kind: "absolute",
    timezone: requiredString(input, "timezone", INPUT_ERROR_CODE, "Europe/Moscow", { maxLength: 100 }),
  };
}

function requireCreateInput(input: Record<string, unknown>) {
  requireOnlyFields(input, [
    "action",
    "content",
    "firstRunAt",
    "firstRunInMinutes",
    "localFirstRun",
    "recurrence",
    "scope",
    "timezone",
  ], "action=create", INPUT_ERROR_CODE);
  const { buttons, content } = contentInput(input, true)!;
  return {
    ...(buttons === null ? {} : { buttons }),
    content,
    recurrence: requireReminderRecurrence(input.recurrence),
    scope: requiredEnum(input, "scope", SCOPES, INPUT_ERROR_CODE) as (typeof SCOPES)[number],
    time: requireTimeInput(input),
  };
}

function requireUpdateInput(input: Record<string, unknown>) {
  requireOnlyFields(input, [
    "action",
    "content",
    "firstRunAt",
    "id",
    "localFirstRun",
    "recurrence",
    // MiniMax materializes these known create-only siblings; update ignores them explicitly.
    "scope",
    "timezone",
  ], "action=update", INPUT_ERROR_CODE);
  // New content brings its own buttons or none; without new content the buttons stay.
  const content = contentInput(input, false);
  const firstRunAt = optionalIsoDate(input, "firstRunAt", INPUT_ERROR_CODE);
  const localFirstRun = input.localFirstRun === undefined
    ? undefined
    : parseLocalFirstRun(requiredString(input, "localFirstRun", INPUT_ERROR_CODE, "2026-08-01T10:00"));
  const recurrence = optionalReminderRecurrence(input.recurrence);
  if (content === undefined && firstRunAt === undefined && localFirstRun === undefined && recurrence === undefined) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Для action=update передайте хотя бы одно изменение: content, firstRunAt, localFirstRun или recurrence",
    );
  }
  return {
    ...(content === undefined ? {} : content),
    firstRunAt,
    id: requireReminderId(input),
    localFirstRun,
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
  "content is read at the moment of delivery: no words like \"завтра\" or \"через час\", name the event time by the clock.",
  "Not an agent schedule: for future work with research or a report use manage_agent_schedule.",
  "The result's calendarCopy says whether the reminder appears in the person's Google Calendar by itself (will_appear) or why not; never create a separate calendar event for a reminder.",
  "content is laid out like your answers, Markdown, reply buttons and a workspace file on its own line as ![caption](/workspace/...) included; a file is checked now and read at delivery, so it must stay in place.",
  "Name the first run exactly one way: firstRunAt with timezone when the person's zone is set; localFirstRun, the clock time the person said as YYYY-MM-DDTHH:MM without a zone, when it is not; firstRunInMinutes for a countdown such as «через 20 минут».",
  "Without the person's zone a localFirstRun returns status awaiting_timezone: the reminder waits and is set by itself once the zone is saved; a countdown is set at once, alone or repeating by minutes or hours.",
  "Create payload: {\"action\":\"create\",\"content\":\"Позвонить врачу\",\"firstRunAt\":\"2026-08-01T10:00:00+03:00\",\"timezone\":\"Europe/Moscow\",\"scope\":\"personal\",\"recurrence\":null}.",
  "Recurrence: none is recurrence=null; a repeat is {\"unit\":\"daily\",\"interval\":1} with unit minutely, hourly, daily, weekly, monthly or yearly and interval 1-365.",
  "Update passes id and only the changed content, firstRunAt or recurrence (recurrence=null removes the repeat); a waiting reminder takes content or localFirstRun. Pause, resume and delete pass only action and id; a waiting reminder cannot be paused. Take the id from list_reminders and do not delete and re-create a reminder to change it.",
  "firstRunAt is an ISO datetime with a UTC offset, timezone is IANA. A delivered one-time reminder cannot change: create a new one.",
].join(" ");

export const MANAGE_REMINDER_CALL_EXAMPLES: CallExamples = {
  create: { action: "create", content: "Пора позвонить врачу", firstRunAt: "2026-08-01T10:00:00+03:00", timezone: "Europe/Moscow", scope: "personal", recurrence: null },
  update: { action: "update", id: "<id из list_reminders>", firstRunAt: "2026-08-01T11:00:00+03:00" },
  pause: { action: "pause", id: "<id из list_reminders>" },
  resume: { action: "resume", id: "<id из list_reminders>" },
  delete: { action: "delete", id: "<id из list_reminders>" },
};

export default withCallExamples(defineTool({
  // Repeating it after a crash is safe: its effect is keyed on the call id.
  replaySafe: true,
  description: TOOL_DESCRIPTION,
  inputSchema: manageReminderSchema,
  async execute(input, ctx) {
    const parsed = requireManageReminderInput(input);
    const authorization = requireReminderAuthorization(ctx);
    // A replay after a crash is answered from its recorded effect: the files it named may have moved
    // since, and refusing them now would read as "not created".
    const namesFiles = parsed.action === "create" || (parsed.action === "update" && parsed.values.content !== undefined);
    const replayed = namesFiles && (
      await reminderRepository.operationRecorded(authorization, ctx.callId) ||
      await timezoneWaitRepository.operationRecorded(authorization, ctx.callId)
    );
    if (parsed.action === "create") {
      if (!replayed) {
        await requireReminderContent({
          content: parsed.values.content,
          errorCode: INPUT_ERROR_CODE,
          rights: () => reminderWriterRights(authorization),
          scope: parsed.values.scope,
        });
      }
      const outcome = await createReminderOrWait(authorization, { ...parsed.values, operationKey: ctx.callId });
      if (outcome.kind === "awaiting") {
        const nextStep = authorization.telegramChatType === "private"
          ? AWAITING_NEXT_STEP.replace("{suggestedLabel}", outcome.awaiting.suggestedLabel)
          : AWAITING_NEXT_STEP_IN_GROUP;
        return { ...outcome.awaiting, nextStep };
      }
      return { ...outcome.reminder, calendarCopy: await calendarCopyOutlook(authorization, outcome.reminder) };
    }
    const targetId = parsed.action === "update" ? parsed.values.id : parsed.id;
    const waitScope = await timezoneWaitRepository.scopeOf(authorization, targetId);
    if (waitScope !== null) {
      if (parsed.action === "update") {
        const { buttons, content, firstRunAt, localFirstRun, recurrence } = parsed.values;
        if (firstRunAt !== undefined || recurrence !== undefined) {
          toolInputError(INPUT_ERROR_CODE, "У напоминания, которое ждёт часового пояса, меняются только content и localFirstRun");
        }
        if (content !== undefined && !replayed) {
          await requireReminderContent({ content, errorCode: INPUT_ERROR_CODE, rights: () => reminderWriterRights(authorization), scope: waitScope });
        }
        return await timezoneWaitRepository.update(authorization, targetId, {
          ...(content === undefined ? {} : { buttons: buttons ?? null, content }),
          ...(localFirstRun === undefined ? {} : { localFirstRun }),
          now: new Date(),
        });
      }
      if (parsed.action === "delete") {
        return { deleted: await timezoneWaitRepository.delete(authorization, targetId, new Date()) };
      }
      throw new AppError(
        "AGENT_REMINDER_AWAITING_ACTION_UNSUPPORTED",
        "Напоминание ещё ждёт часового пояса: его можно изменить или удалить, но не приостановить",
      );
    }
    if (parsed.action === "update") {
      const { id, localFirstRun, ...values } = parsed.values;
      if (localFirstRun !== undefined) {
        toolInputError(INPUT_ERROR_CODE, "localFirstRun меняет только напоминание, которое ждёт часового пояса; для поставленного передайте firstRunAt");
      }
      // A reminder that is not found, or a public chat's one this tool may not change, is reported
      // by the update itself.
      const scope = !namesFiles || replayed ? null : await reminderRepository.scopeOf(authorization, id);
      if (values.content !== undefined && scope !== null && scope !== "group") {
        await requireReminderContent({
          content: values.content, errorCode: INPUT_ERROR_CODE, rights: () => reminderWriterRights(authorization), scope,
        });
      }
      const updated = await reminderRepository.update(authorization, id, {
        ...values,
        operationKey: ctx.callId,
      });
      return { ...updated, calendarCopy: await calendarCopyOutlook(authorization, updated) };
    }
    if (parsed.action === "pause" || parsed.action === "resume") {
      const switched = await reminderRepository.update(authorization, parsed.id, {
        enabled: parsed.action === "resume",
        operationKey: ctx.callId,
      });
      return { ...switched, calendarCopy: await calendarCopyOutlook(authorization, switched) };
    }

    return {
      deleted: await reminderRepository.delete(authorization, parsed.id, ctx.callId),
    };
  },
}), MANAGE_REMINDER_CALL_EXAMPLES);
