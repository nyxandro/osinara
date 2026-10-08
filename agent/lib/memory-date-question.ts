/**
 * Reading the day or period a question is about.
 *
 * Exports:
 * - `MemoryDateWindow`: the inclusive days a question points at, and the form that named them.
 * - `memoryDateWindow`: the window an explicit date expression names, or null.
 * - `localDate`: today as a calendar day in a timezone.
 *
 * «Что было вчера?» finds nothing by words or meaning: the record of that day does not say
 * «вчера», it says what happened. The day lives in the record's event date, which only the period
 * search reads — and the model asked for a period in 2 of 255 measured answers (#344). The
 * automatic selection therefore reads the date itself, for the explicit forms people use.
 *
 * Only explicit forms are read. «В прошлый раз», «тогда», «недавно» name no day, and «сегодня» is
 * as often about the weather as about the past; guessing a window for them would fill the
 * selection with a day the person did not ask about.
 */

export interface MemoryDateWindow {
  form: "day" | "days_ago" | "day_before_yesterday" | "last_month" | "last_week" | "month"
    | "this_month" | "this_week" | "week_ago" | "yesterday";
  from: string;
  to: string;
}

const MONTHS: readonly RegExp[] = [
  /^январ/u, /^феврал/u, /^март/u, /^апрел/u, /^ма[йяе]$/u, /^июн/u,
  /^июл/u, /^август/u, /^сентябр/u, /^октябр/u, /^ноябр/u, /^декабр/u,
];
// Words a month is written with in a question: «в июне», «3 марта», «за август», «май 2025».
const MONTH_WORD = "(январ[ьяе]|феврал[ьяе]|марта?|марте|апрел[ьяе]|ма[йяе]|июн[ьяе]|июл[ьяе]|августа?|августе|сентябр[ьяе]|октябр[ьяе]|ноябр[ьяе]|декабр[ьяе])";
const BEFORE = "(?:^|[^\\p{L}\\p{N}])";
const AFTER = "(?=$|[^\\p{L}\\p{N}])";

const DAY_OF_MONTH = new RegExp(`${BEFORE}(\\d{1,2})(?:-?го)?\\s+${MONTH_WORD}(?:\\s+(\\d{4}))?${AFTER}`, "u");
const WHOLE_MONTH = new RegExp(`${BEFORE}(?:(?:в|во|за)\\s+)?${MONTH_WORD}(?:\\s+(\\d{4}))?${AFTER}`, "u");
const DAYS_AGO = new RegExp(`${BEFORE}(\\d{1,3})\\s+(?:день|дня|дней)\\s+назад${AFTER}`, "u");
// The longest day count read as «N дней назад»: past a year, a single day is no longer what is meant.
const MAX_DAYS_AGO = 366;

function day(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shift(today: string, days: number): string {
  const date = day(today);
  date.setUTCDate(date.getUTCDate() + days);
  return iso(date);
}

function monthBounds(year: number, monthIndex: number): { from: string; to: string } {
  return {
    from: iso(new Date(Date.UTC(year, monthIndex, 1))),
    to: iso(new Date(Date.UTC(year, monthIndex + 1, 0))),
  };
}

/** No window reaches past today: a month or week still running ends where the day is. */
function clampToToday(window: MemoryDateWindow, today: string): MemoryDateWindow | null {
  if (window.from > today) return null;
  return window.to > today ? { ...window, to: today } : window;
}

function monthIndex(word: string): number {
  return MONTHS.findIndex((pattern) => pattern.test(word));
}

/** Without a year the month meant is the latest one not in the future. */
function yearFor(today: string, month: number, dayOfMonth: number, explicit: string | undefined): number {
  if (explicit !== undefined) return Number(explicit);
  const current = day(today);
  const candidate = Date.UTC(current.getUTCFullYear(), month, dayOfMonth);
  return candidate > current.getTime() ? current.getUTCFullYear() - 1 : current.getUTCFullYear();
}

/**
 * `today` is the person's calendar day, `YYYY-MM-DD`. The first form found wins, the most specific
 * first: «3 марта» before «марта», «позавчера» before «вчера».
 */
export function memoryDateWindow(text: string, today: string): MemoryDateWindow | null {
  const lower = text.toLocaleLowerCase("ru-RU").replaceAll("ё", "е");

  const exact = DAY_OF_MONTH.exec(lower);
  if (exact !== null) {
    const month = monthIndex(exact[2]!);
    const dayOfMonth = Number(exact[1]);
    const year = yearFor(today, month, dayOfMonth, exact[3]);
    const date = new Date(Date.UTC(year, month, dayOfMonth));
    // «31 февраля» rolls into March in Date; a day the month does not have names no day.
    if (date.getUTCMonth() === month && dayOfMonth >= 1) {
      return clampToToday({ form: "day", from: iso(date), to: iso(date) }, today);
    }
  }
  if (new RegExp(`${BEFORE}позавчера`, "u").test(lower)) {
    const date = shift(today, -2);
    return { form: "day_before_yesterday", from: date, to: date };
  }
  if (new RegExp(`${BEFORE}вчера`, "u").test(lower)) {
    const date = shift(today, -1);
    return { form: "yesterday", from: date, to: date };
  }
  const ago = DAYS_AGO.exec(lower);
  if (ago !== null && Number(ago[1]) >= 1 && Number(ago[1]) <= MAX_DAYS_AGO) {
    const date = shift(today, -Number(ago[1]));
    return { form: "days_ago", from: date, to: date };
  }
  // «Неделю назад» is loose in speech: the day before and the day after are the same answer.
  if (new RegExp(`${BEFORE}неделю\\s+назад${AFTER}`, "u").test(lower)) {
    return { form: "week_ago", from: shift(today, -8), to: shift(today, -6) };
  }
  const weekday = (day(today).getUTCDay() + 6) % 7;
  if (new RegExp(`${BEFORE}на\\s+прошлой\\s+неделе${AFTER}`, "u").test(lower)) {
    return { form: "last_week", from: shift(today, -weekday - 7), to: shift(today, -weekday - 1) };
  }
  if (new RegExp(`${BEFORE}на\\s+этой\\s+неделе${AFTER}`, "u").test(lower)) {
    return { form: "this_week", from: shift(today, -weekday), to: today };
  }
  const current = day(today);
  if (new RegExp(`${BEFORE}в\\s+прошлом\\s+месяце${AFTER}`, "u").test(lower)) {
    return { form: "last_month", ...monthBounds(current.getUTCFullYear(), current.getUTCMonth() - 1) };
  }
  if (new RegExp(`${BEFORE}в\\s+этом\\s+месяце${AFTER}`, "u").test(lower)) {
    return { form: "this_month", from: monthBounds(current.getUTCFullYear(), current.getUTCMonth()).from, to: today };
  }
  const whole = WHOLE_MONTH.exec(lower);
  // A bare month word is read only with a preposition or a year: «март» alone may be a name.
  if (whole !== null && (whole[0].trim().split(/\s+/u).length > 1)) {
    const month = monthIndex(whole[1]!);
    const year = yearFor(today, month, 1, whole[2]);
    return clampToToday({ form: "month", ...monthBounds(year, month) }, today);
  }
  return null;
}

/** Today as a calendar day where the person is; UTC when nobody said where that is. */
export function localDate(now: Date, timezone: string | null): string {
  if (timezone === null) return now.toISOString().slice(0, 10);
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit", month: "2-digit", timeZone: timezone, year: "numeric",
  }).format(now);
}
