/**
 * What the owner reads before a group automation is created or changed.
 *
 * Exports:
 * - `EXTERNAL_SCHEDULE_ACTION_LABELS`: the card header for create and update.
 * - `externalScheduleFacts`: readable lines for every field the call sets, plus the automation and
 *   group it targets when the caller resolved them.
 *
 * Every field that reaches the scheduled run is shown, `userRequest` included: the run receives it
 * as the person's original request. An update carries only the fields it changes, and a null that
 * removes a limit is shown as removed, so a changed automation never reaches the owner as an empty
 * card.
 */
import { approvalFact } from "./approval-message.js";

export const EXTERNAL_SCHEDULE_ACTION_LABELS: Readonly<Record<string, string>> = {
  create: "создать автоматизацию, которая будет по расписанию публиковать результат во внешнюю Telegram-группу",
  update: "изменить автоматизацию, публикующую результат во внешнюю Telegram-группу",
};

export interface ExternalScheduleTarget {
  /** Present for an update: the automation being changed. */
  readonly automationTitle?: string;
  readonly groupTitle: string;
  readonly telegramChatId: string;
}

type PluralForms = readonly [one: string, few: string, many: string];

const EVERY_ONE: Readonly<Record<string, string>> = {
  daily: "каждый день",
  hourly: "каждый час",
  minutely: "каждую минуту",
  monthly: "каждый месяц",
  yearly: "каждый год",
};
const UNIT_FORMS: Readonly<Record<string, PluralForms>> = {
  daily: ["день", "дня", "дней"],
  hourly: ["час", "часа", "часов"],
  minutely: ["минуту", "минуты", "минут"],
  monthly: ["месяц", "месяца", "месяцев"],
  yearly: ["год", "года", "лет"],
};
const WEEKDAYS = ["", "пн", "вт", "ср", "чт", "пт", "сб", "вс"] as const;

function plural(count: number, forms: PluralForms): string {
  const tens = count % 100;
  const units = count % 10;
  if (tens >= 11 && tens <= 14) return forms[2];
  if (units === 1) return forms[0];
  if (units >= 2 && units <= 4) return forms[1];
  return forms[2];
}

function recurrenceText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const recurrence = value as { daysOfWeek?: unknown; interval?: unknown; kind?: unknown };
  if (recurrence.kind === "once") return "однократно";
  const interval = recurrence.interval;
  if (typeof interval !== "number") return null;
  if (recurrence.kind === "weekly" && Array.isArray(recurrence.daysOfWeek)) {
    const days = recurrence.daysOfWeek.map((day) => (typeof day === "number" ? WEEKDAYS[day] : undefined));
    if (days.some((day) => !day)) return null;
    const period = interval === 1 ? "каждую неделю" : `раз в ${interval} ${plural(interval, ["неделю", "недели", "недель"])}`;
    return `${period} по дням: ${days.join(", ")}`;
  }
  const kind = typeof recurrence.kind === "string" ? recurrence.kind : "";
  const forms = UNIT_FORMS[kind];
  if (!forms) return null;
  return interval === 1 ? EVERY_ONE[kind]! : `раз в ${interval} ${plural(interval, forms)}`;
}

export function externalScheduleFacts(
  input: Readonly<Record<string, unknown>>,
  target?: ExternalScheduleTarget,
): string[] {
  const text = (key: string): unknown => input[key];
  const firstRun = typeof input.firstRunAt === "string" ? input.firstRunAt : null;
  const timezone = typeof input.timezone === "string" ? input.timezone : null;
  const capabilities = Array.isArray(input.capabilityAllowlist)
    ? input.capabilityAllowlist.filter((item): item is string => typeof item === "string").join(", ")
    : null;
  const recurrence = input.recurrence === undefined ? null : recurrenceText(input.recurrence);
  return [
    ...approvalFact("Автоматизация", target?.automationTitle),
    ...(target
      ? approvalFact("Группа", `${target.groupTitle} (${target.telegramChatId})`)
      : approvalFact("Telegram chat ID", text("telegramChatId"))),
    ...approvalFact(target?.automationTitle === undefined ? "Название" : "Новое название", text("title")),
    ...(firstRun ? approvalFact("Первый запуск", timezone ? `${firstRun} (${timezone})` : firstRun) : []),
    ...approvalFact("Следующий запуск", text("nextRunAt")),
    ...(input.recurrence === undefined
      ? []
      : approvalFact("Повторение", recurrence ?? JSON.stringify(input.recurrence))),
    ...approvalFact("Исходная просьба", text("userRequest")),
    ...approvalFact("Сценарий", text("scenarioPrompt")),
    ...(capabilities === null ? [] : approvalFact("Дополнительные инструменты", capabilities || "нет")),
    ...(typeof input.historyWindowDays === "number"
      ? approvalFact("История группы", `за ${input.historyWindowDays} дн.`)
      : input.historyWindowDays === null ? approvalFact("История группы", "не читается") : []),
    ...(typeof input.maxRuns === "number"
      ? approvalFact("Число запусков", String(input.maxRuns))
      : input.maxRuns === null ? approvalFact("Число запусков", "без ограничения") : []),
  ];
}
