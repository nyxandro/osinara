/**
 * Recurrence translation between reminders and Google Calendar RRULE.
 *
 * Exports:
 * - `reminderRecurrenceRule`: the RRULE that repeats on exactly the bot's days. Month ends and the
 *   leap day use `BYSETPOS=-1` over the possible last days, checked against live Google 2026-11-02.
 * - `parseGoogleRecurrence`: a rule a person set in Google, accepted only when the bot repeats the
 *   same way; anything else (several weekdays, «third Tuesday», an end date or count) is refused.
 */
import { REMINDER_RECURRENCE_INTERVAL_MAX } from "../reminders/reminder-config.js";
import type { MirrorRecurrence } from "./calendar-mirror-contract.js";
import { localParts, localWeekday } from "./calendar-mirror-local-time.js";

const MONTH_END_DAYS: Readonly<Record<number, string>> = {
  29: "28,29",
  30: "28,29,30",
  31: "28,29,30,31",
};
const LEAP_DAY_RULE = "BYMONTH=2;BYMONTHDAY=28,29;BYSETPOS=-1";

export function reminderRecurrenceRule(recurrence: MirrorRecurrence, anchorLocal: string): string[] | null {
  const every = `INTERVAL=${recurrence.interval}`;
  const anchor = localParts(anchorLocal);
  switch (recurrence.unit) {
    case "minutely":
    case "hourly":
      return null;
    case "daily":
      return [`RRULE:FREQ=DAILY;${every}`];
    case "weekly":
      return [`RRULE:FREQ=WEEKLY;${every}`];
    case "monthly": {
      const lastDays = MONTH_END_DAYS[anchor.day];
      return [lastDays ? `RRULE:FREQ=MONTHLY;${every};BYMONTHDAY=${lastDays};BYSETPOS=-1` : `RRULE:FREQ=MONTHLY;${every}`];
    }
    case "yearly":
      return [anchor.month === 2 && anchor.day === 29
        ? `RRULE:FREQ=YEARLY;${every};${LEAP_DAY_RULE}`
        : `RRULE:FREQ=YEARLY;${every}`];
  }
}

export type GoogleRecurrence =
  | { kind: "none" }
  | { kind: "unsupported" }
  | {
    /** Day of month the bot anchors to: 31 for «last day», when the start fell on a shorter month. */
    anchorDay: number;
    anchorMonth: number;
    kind: "supported";
    recurrence: MirrorRecurrence;
  };

const UNSUPPORTED = { kind: "unsupported" } as const;
const ALLOWED_KEYS = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYSETPOS", "WKST"]);
const FREQUENCIES = { DAILY: "daily", MONTHLY: "monthly", WEEKLY: "weekly", YEARLY: "yearly" } as const;

function ruleParts(line: string): Map<string, string> | null {
  const parts = new Map<string, string>();
  for (const part of line.slice("RRULE:".length).split(";")) {
    const [key, value, extra] = part.split("=");
    if (!key || value === undefined || extra !== undefined || !ALLOWED_KEYS.has(key) || parts.has(key)) return null;
    parts.set(key, value);
  }
  return parts;
}

function onlyKeys(parts: Map<string, string>, allowed: readonly string[]): boolean {
  return [...parts.keys()].every((key) => key === "FREQ" || key === "INTERVAL" || key === "WKST" || allowed.includes(key));
}

export function parseGoogleRecurrence(lines: readonly string[] | undefined, startLocal: string): GoogleRecurrence {
  if (!lines || lines.length === 0) return { kind: "none" };
  if (lines.length !== 1 || !lines[0]!.startsWith("RRULE:")) return UNSUPPORTED;
  const parts = ruleParts(lines[0]!);
  if (!parts) return UNSUPPORTED;
  const unit = FREQUENCIES[parts.get("FREQ") as keyof typeof FREQUENCIES];
  if (!unit) return UNSUPPORTED;
  const rawInterval = parts.get("INTERVAL") ?? "1";
  const interval = Number(rawInterval);
  if (!/^\d+$/u.test(rawInterval) || interval < 1 || interval > REMINDER_RECURRENCE_INTERVAL_MAX) return UNSUPPORTED;
  const start = localParts(startLocal);
  const plain = { anchorDay: start.day, anchorMonth: start.month, kind: "supported" as const, recurrence: { interval, unit } };
  const byMonthDay = parts.get("BYMONTHDAY");
  const bySetPos = parts.get("BYSETPOS");

  switch (unit) {
    case "daily":
      return onlyKeys(parts, []) ? plain : UNSUPPORTED;
    case "weekly": {
      if (!onlyKeys(parts, ["BYDAY"])) return UNSUPPORTED;
      const byDay = parts.get("BYDAY");
      return byDay === undefined || byDay === localWeekday(startLocal) ? plain : UNSUPPORTED;
    }
    case "monthly": {
      if (!onlyKeys(parts, ["BYMONTHDAY", "BYSETPOS"])) return UNSUPPORTED;
      if (byMonthDay === undefined && bySetPos === undefined) return plain;
      if (bySetPos === undefined) return byMonthDay === String(start.day) ? plain : UNSUPPORTED;
      const lastDay = Object.entries(MONTH_END_DAYS).find(([, days]) => days === byMonthDay)?.[0];
      return bySetPos === "-1" && lastDay !== undefined && start.day >= 28
        ? { ...plain, anchorDay: Number(lastDay) }
        : UNSUPPORTED;
    }
    case "yearly": {
      if (!onlyKeys(parts, ["BYMONTH", "BYMONTHDAY", "BYSETPOS"])) return UNSUPPORTED;
      const byMonth = parts.get("BYMONTH");
      if (bySetPos !== undefined) {
        return `BYMONTH=${byMonth};BYMONTHDAY=${byMonthDay};BYSETPOS=${bySetPos}` === LEAP_DAY_RULE &&
          start.month === 2 && start.day >= 28
          ? { ...plain, anchorDay: 29 }
          : UNSUPPORTED;
      }
      const monthMatches = byMonth === undefined || byMonth === String(start.month);
      const dayMatches = byMonthDay === undefined || byMonthDay === String(start.day);
      return monthMatches && dayMatches ? plain : UNSUPPORTED;
    }
  }
}
