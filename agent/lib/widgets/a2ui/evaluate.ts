/**
 * Computing A2UI values against a widget's data model, the way the widget will show them.
 *
 * Exports:
 * - `EvaluationScope`: the data model, the list item a template renders, and the paths read so far.
 * - `WidgetEvaluationError`: a value that cannot be shown, with the pointer of the field.
 * - `evaluateString`, `evaluateNumber`, `evaluateBoolean`, `evaluateValue`: one value of each type.
 * - `resolvePointer`: an absolute pointer for a binding in its scope.
 * - `WIDGET_LOCALE`: the locale every number, amount and date is written in.
 *
 * Key constructs:
 * - Values are computed when the widget is built and again when the agent updates its data, never in
 *   the widget: the widget gets ready text, so its script stays small and identical for all widgets.
 * - Every absolute path a value reads is recorded, so an update knows which shown values it changes.
 * - A2UI converts a missing value to an empty string; a number or a date that is missing or malformed
 *   is an error instead, because a bar or a timer cannot show "nothing" truthfully.
 * - A moment is written in the UTC offset it was given with; a time zone is never guessed, so a moment
 *   without an offset is refused.
 */
import {
  type JsonObject,
  type JsonValue,
  isFunctionCall,
  isPathBinding,
  isRecord,
  parsePointer,
  readPointer,
} from "./a2ui-types.js";

export const WIDGET_LOCALE = "ru-RU";

const MONTHS_GENITIVE = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_SHORT = ["янв.", "февр.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек."];
const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const WEEKDAYS_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MOMENT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/u;
const DATE_TOKEN = /yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|E|HH|H|mm|ss|'[^']*'/gu;
const TIME_TOKENS = new Set(["HH", "H", "mm", "ss"]);
const PLACEHOLDER = /\\\$\{|\$\{([^}]*)\}/gu;

export class WidgetEvaluationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "WidgetEvaluationError";
    this.field = field;
  }
}

export interface EvaluationScope {
  readonly dataModel: JsonObject;
  /** Absolute tokens of the list item a template renders; relative paths resolve under it. */
  readonly item: readonly string[] | null;
  /** Absolute pointers read while computing, for update tracking. */
  readonly reads: Set<string>;
}

function encodeToken(token: string): string {
  return token.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

export function resolvePointer(pointer: string, scope: EvaluationScope, field: string): string[] {
  const tokens = parsePointer(pointer);
  if (tokens === null) throw new WidgetEvaluationError(field, `"${pointer}" is not a JSON Pointer`);
  if (pointer.startsWith("/") || pointer === "") return tokens;
  if (scope.item === null) throw new WidgetEvaluationError(field, `relative path "${pointer}" outside a list template`);
  return [...scope.item, ...tokens];
}

function read(pointer: string, scope: EvaluationScope, field: string): JsonValue | undefined {
  const tokens = resolvePointer(pointer, scope, field);
  scope.reads.add(`/${tokens.map(encodeToken).join("/")}`);
  return readPointer(scope.dataModel, tokens);
}

function asText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function formatString(template: string, scope: EvaluationScope, field: string): string {
  return template.replace(PLACEHOLDER, (match, expression: string | undefined) => {
    if (match === "\\${") return "${";
    return asText(read((expression ?? "").trim(), scope, field));
  });
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDate(value: string, pattern: string, field: string): string {
  const moment = MOMENT.exec(value);
  const date = DATE_ONLY.exec(value);
  if (moment === null && date === null) {
    throw new WidgetEvaluationError(field, `"${value}" is not an ISO date (2026-11-07) or a moment with its offset (2026-11-07T17:30:00+03:00)`);
  }
  const tokens = pattern.match(DATE_TOKEN) ?? [];
  if (moment === null && tokens.some((token) => TIME_TOKENS.has(token))) {
    throw new WidgetEvaluationError(field, `"${value}" has no time, but the pattern shows one: give a moment with its offset`);
  }
  let parts: { year: number; month: number; day: number; weekday: number; hour: number; minute: number; second: number };
  if (moment !== null) {
    const millis = Date.parse(value);
    if (Number.isNaN(millis)) throw new WidgetEvaluationError(field, `"${value}" is not a real moment`);
    const offset = moment[7] === "Z" ? 0 : (moment[7]!.startsWith("-") ? -1 : 1) * (Number(moment[7]!.slice(1, 3)) * 60 + Number(moment[7]!.slice(4, 6)));
    const local = new Date(millis + offset * 60_000);
    parts = {
      day: local.getUTCDate(), hour: local.getUTCHours(), minute: local.getUTCMinutes(), month: local.getUTCMonth(),
      second: local.getUTCSeconds(), weekday: local.getUTCDay(), year: local.getUTCFullYear(),
    };
  } else {
    const local = new Date(Date.UTC(Number(date![1]), Number(date![2]) - 1, Number(date![3])));
    if (local.getUTCMonth() !== Number(date![2]) - 1) throw new WidgetEvaluationError(field, `"${value}" is not a real date`);
    parts = { day: local.getUTCDate(), hour: 0, minute: 0, month: local.getUTCMonth(), second: 0, weekday: local.getUTCDay(), year: local.getUTCFullYear() };
  }
  return pattern.replace(DATE_TOKEN, (token) => {
    switch (token) {
      case "yyyy": return String(parts.year);
      case "yy": return pad(parts.year % 100);
      case "MMMM": return MONTHS_GENITIVE[parts.month]!;
      case "MMM": return MONTHS_SHORT[parts.month]!;
      case "MM": return pad(parts.month + 1);
      case "M": return String(parts.month + 1);
      case "dd": return pad(parts.day);
      case "d": return String(parts.day);
      case "EEEE": return WEEKDAYS[parts.weekday]!;
      case "E": return WEEKDAYS_SHORT[parts.weekday]!;
      case "HH": return pad(parts.hour);
      case "H": return String(parts.hour);
      case "mm": return pad(parts.minute);
      case "ss": return pad(parts.second);
      default: return token.slice(1, -1);
    }
  });
}

function args(value: { args?: Record<string, unknown> }): Record<string, unknown> {
  return isRecord(value.args) ? value.args : {};
}

function call(value: { "@call": string; args?: Record<string, unknown> }, scope: EvaluationScope, field: string): string | boolean {
  const given = args(value);
  switch (value["@call"]) {
    case "formatString":
      return formatString(evaluateString(given.value, scope, `${field}/args/value`, true), scope, `${field}/args/value`);
    case "formatNumber": {
      const decimals = given.decimals === undefined ? 0 : evaluateNumber(given.decimals, scope, `${field}/args/decimals`);
      return new Intl.NumberFormat(WIDGET_LOCALE, {
        maximumFractionDigits: decimals,
        minimumFractionDigits: decimals,
        useGrouping: given.grouping === undefined ? true : evaluateBoolean(given.grouping, scope, `${field}/args/grouping`),
      }).format(evaluateNumber(given.value, scope, `${field}/args/value`));
    }
    case "formatCurrency": {
      const currency = evaluateString(given.currency, scope, `${field}/args/currency`);
      if (!/^[A-Z]{3}$/u.test(currency)) throw new WidgetEvaluationError(`${field}/args/currency`, `"${currency}" is not an ISO 4217 code such as RUB`);
      const decimals = given.decimals === undefined ? 0 : evaluateNumber(given.decimals, scope, `${field}/args/decimals`);
      return new Intl.NumberFormat(WIDGET_LOCALE, { currency, maximumFractionDigits: decimals, minimumFractionDigits: decimals, style: "currency" })
        .format(evaluateNumber(given.value, scope, `${field}/args/value`));
    }
    case "formatDate":
      return formatDate(evaluateString(given.value, scope, `${field}/args/value`), evaluateString(given.format, scope, `${field}/args/format`), `${field}/args/value`);
    case "pluralize": {
      const category = new Intl.PluralRules(WIDGET_LOCALE).select(evaluateNumber(given.value, scope, `${field}/args/value`));
      const form = given[category] ?? given.other;
      return evaluateString(form, scope, `${field}/args/${given[category] === undefined ? "other" : category}`);
    }
    case "and":
      return (given.values as unknown[]).every((item, index) => evaluateBoolean(item, scope, `${field}/args/values/${index}`));
    case "or":
      return (given.values as unknown[]).some((item, index) => evaluateBoolean(item, scope, `${field}/args/values/${index}`));
    case "not":
      return !evaluateBoolean(given.value, scope, `${field}/args/value`);
    default:
      throw new WidgetEvaluationError(`${field}/@call`, `${value["@call"]} cannot be computed here`);
  }
}

/** A string value; `raw` keeps a formatString template unexpanded for the caller to fill. */
export function evaluateString(value: unknown, scope: EvaluationScope, field: string, raw = false): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isPathBinding(value)) return asText(read(value["@path"], scope, field));
  if (isFunctionCall(value)) {
    const result = call(value, scope, field);
    return typeof result === "string" ? result : String(result);
  }
  if (raw) return "";
  throw new WidgetEvaluationError(field, "not a text value");
}

export function evaluateNumber(value: unknown, scope: EvaluationScope, field: string): number {
  const result = typeof value === "number" ? value : isPathBinding(value) ? read(value["@path"], scope, field) : undefined;
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new WidgetEvaluationError(field, isPathBinding(value) ? `no number at ${value["@path"]} in the data model` : "a number is expected");
  }
  return result;
}

export function evaluateBoolean(value: unknown, scope: EvaluationScope, field: string): boolean {
  if (typeof value === "boolean") return value;
  if (isPathBinding(value)) {
    const result = read(value["@path"], scope, field);
    return result !== undefined && result !== null && result !== false && result !== 0 && result !== "";
  }
  if (isFunctionCall(value)) return call(value, scope, field) === true;
  throw new WidgetEvaluationError(field, "a boolean is expected");
}

/** A value of any type, as an action's context carries it to the agent. */
export function evaluateValue(value: unknown, scope: EvaluationScope, field: string): JsonValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (isPathBinding(value)) return read(value["@path"], scope, field) ?? null;
  if (isFunctionCall(value)) return call(value, scope, field);
  throw new WidgetEvaluationError(field, "not a value");
}
