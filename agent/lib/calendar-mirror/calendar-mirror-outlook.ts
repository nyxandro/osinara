/**
 * Whether a reminder will have a copy in Google Calendar, for the model's reply.
 *
 * Export:
 * - `calendarCopyOutlook`: `will_appear` when the copy comes within a minute or two; otherwise why
 *   not, so the model can answer a person who asked «и в календарь тоже».
 *
 * It is read after the reminder is already written. A failure to read it must not turn a written
 * reminder into a failed call, which the model could repeat as a second reminder: it is logged and
 * reported as `unknown`, about which the model promises nothing.
 */
import type { ReminderRecord } from "../reminders/reminder-record.js";
import { calendarMirrorRepository } from "./calendar-mirror-repository.js";

export type CalendarCopyOutlook = "calendar_stopped" | "no_google" | "not_shown_frequent" | "paused" | "unknown" | "will_appear";

export async function calendarCopyOutlook(
  auth: { familyId: string; userId: string },
  reminder: Pick<ReminderRecord, "recurrence" | "scope" | "status">,
): Promise<CalendarCopyOutlook> {
  if (reminder.scope === "group") return "no_google";
  let state: Awaited<ReturnType<typeof calendarMirrorRepository.stateFor>>;
  try {
    state = await calendarMirrorRepository.stateFor({ familyId: auth.familyId, scope: reminder.scope, userId: auth.userId });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_CALENDAR_MIRROR_OUTLOOK_FAILED",
      error: error instanceof Error ? error.message : String(error),
    }));
    return "unknown";
  }
  if (state === null) return "no_google";
  if (state !== "active") return "calendar_stopped";
  const unit = reminder.recurrence?.unit;
  if (unit === "minutely" || unit === "hourly") return "not_shown_frequent";
  if (reminder.status === "paused" || reminder.status === "failed") return "paused";
  return "will_appear";
}
