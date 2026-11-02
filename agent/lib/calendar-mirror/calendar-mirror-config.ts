/**
 * Product constants and texts of the reminder ↔ Google Calendar mirror.
 *
 * Exports: calendar names and descriptions, copy layout, cycle limits and the private event marks.
 */
import { AGENT_DISPLAY_NAME } from "../agent-name.js";
import type { CalendarMirrorScope } from "./calendar-mirror-contract.js";

/** Length of a copy: long enough to be visible in the calendar grid, marked free so it blocks nothing. */
export const CALENDAR_MIRROR_EVENT_MINUTES = 15;
/** Characters of the reminder's first line shown in the copy's title, without the bell. */
export const CALENDAR_MIRROR_TITLE_MAX = 100;
export const CALENDAR_MIRROR_TITLE_PREFIX = "🔔 ";
/** Google writes per profile in one cycle: a large transfer spreads over minutes within Google's limits. */
export const CALENDAR_MIRROR_WRITES_PER_TICK = 20;
/** No new Google call starts after this much of a profile's cycle; one write took up to 7.6 s live. */
export const CALENDAR_MIRROR_PROFILE_BUDGET_MS = 20_000;
export const CALENDAR_MIRROR_BACKOFF_MAX_MINUTES = 60;
/** Google finishes deleting a calendar over minutes, so «no such calendar» counts only when it lasts. */
export const CALENDAR_MIRROR_CALENDAR_GONE_CONFIRM_MINUTES = 5;
/** A disconnect takes seconds; «removing» older than this was left by a disconnect that died midway. */
export const CALENDAR_MIRROR_REMOVING_STALE_MINUTES = 10;
/** An all-day event in the mirror calendar becomes a reminder at this local time of its day. */
export const CALENDAR_MIRROR_ALL_DAY_REMINDER_TIME = "09:00:00";

/** Own events are created under this id prefix followed by the reminder UUID without dashes. */
export const CALENDAR_MIRROR_EVENT_ID_PREFIX = "osr";
export const CALENDAR_MIRROR_PRIVATE_MARK = "osinaraMirror";
export const CALENDAR_MIRROR_PRIVATE_REMINDER = "osinaraReminderId";

export function calendarMirrorCalendarName(scope: CalendarMirrorScope): string {
  return scope === "personal"
    ? `${AGENT_DISPLAY_NAME} — напоминания`
    : `${AGENT_DISPLAY_NAME} — семейные напоминания`;
}

export function calendarMirrorCalendarDescription(marker: string): string {
  return [
    `Здесь напоминания бота ${AGENT_DISPLAY_NAME}. Их можно переносить, переименовывать и удалять прямо здесь — бот подхватит в течение минуты.`,
    "Новое событие в этом календаре станет напоминанием в Telegram. Повторы — каждый день, неделю, месяц или год.",
    "Если бот перестал вести этот календарь, его можно удалить.",
    marker,
  ].join("\n\n");
}

export const CALENDAR_MIRROR_COPY_FOOTER =
  `Напоминание бота ${AGENT_DISPLAY_NAME}: можно менять здесь или в чате с ботом.`;
