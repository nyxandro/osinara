/**
 * Removal of the mirror calendar from Google.
 *
 * Export:
 * - `removeMirrorCalendar`: deletes the whole calendar when it holds only the bot's copies, or only
 *   the copies when the person keeps own events there.
 *
 * Google answers a calendar deletion at once but finishes it over minutes (checked 2026-11-02);
 * the answer counts as done and is never repeated, a repeat being refused while it finishes.
 */
import type { GoogleCalendarClient } from "../google-workspace/google-calendar-client.js";
import { CALENDAR_MIRROR_PRIVATE_MARK } from "./calendar-mirror-config.js";

export type CalendarRemoval = "kept_with_your_events" | "removed";

export async function removeMirrorCalendar(
  client: Pick<GoogleCalendarClient, "deleteCalendar" | "deleteEvent" | "listEvents">,
  calendarId: string,
): Promise<CalendarRemoval> {
  const events = await client.listEvents(calendarId);
  const copies = events.filter((event) => event.extendedProperties?.private?.[CALENDAR_MIRROR_PRIVATE_MARK] === "1");
  if (copies.length === events.length) {
    await client.deleteCalendar(calendarId);
    return "removed";
  }
  for (const copy of copies) await client.deleteEvent(calendarId, copy.id);
  return "kept_with_your_events";
}
