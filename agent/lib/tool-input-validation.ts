/**
 * Shared model-facing tool input validators.
 *
 * Exports:
 * - `requireInputRecord`: rejects non-object tool payloads before trusted logic runs.
 * - `requireOnlyFields`: fails on misspelled or unsupported payload fields.
 * - `requireAction`: validates action discriminators without publishing JSON Schema unions.
 * - Field validators for strings, enums, UUIDs, ISO datetimes, and plain objects.
 */
import { AppError } from "./app-error.js";

const ISO_OFFSET_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface StringOptions {
  maxLength?: number;
}

export function toolInputError(code: string, message: string): never {
  throw new AppError(code, message);
}

export function requireInputRecord(raw: unknown, toolName: string, code: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    toolInputError(code, `Для ${toolName} передайте JSON-объект с обязательным полем action`);
  }
  return raw as Record<string, unknown>;
}

export function requireOnlyFields(
  input: Record<string, unknown>,
  allowedFields: readonly string[],
  label: string,
  code: string,
): void {
  const allowed = new Set(allowedFields);
  const extra = Object.keys(input).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    toolInputError(
      code,
      `${label} содержит неизвестные поля: ${extra.join(", ")}. Используйте только: ${allowedFields.join(", ")}`,
    );
  }
}

export function requireAction<const T extends readonly string[]>(
  input: Record<string, unknown>,
  toolName: string,
  actions: T,
  code: string,
): T[number] {
  const action = input.action;
  if (typeof action !== "string" || !actions.includes(action)) {
    toolInputError(
      code,
      `Для ${toolName} передайте action: ${actions.join(" | ")}. Пример: {"action":"${actions[0]}",...}`,
    );
  }
  return action;
}

export function requiredString(
  input: Record<string, unknown>,
  key: string,
  code: string,
  example: string,
  options: StringOptions = {},
): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    toolInputError(code, `Поле ${key} обязательно и должно быть непустой строкой. Пример: ${example}`);
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    toolInputError(code, `Поле ${key} должно быть не длиннее ${options.maxLength} символов. Пример: ${example}`);
  }
  return value;
}

export function optionalString(
  input: Record<string, unknown>,
  key: string,
  code: string,
  example: string,
  options: StringOptions = {},
): string | undefined {
  return input[key] === undefined ? undefined : requiredString(input, key, code, example, options);
}

export function requiredEnum<const T extends readonly string[]>(
  input: Record<string, unknown>,
  key: string,
  values: T,
  code: string,
): T[number] {
  const value = requiredString(input, key, code, values[0]);
  if (!values.includes(value)) {
    toolInputError(code, `Поле ${key} должно быть одним из значений: ${values.join(" | ")}`);
  }
  return value;
}

export function optionalEnum<const T extends readonly string[]>(
  input: Record<string, unknown>,
  key: string,
  values: T,
  code: string,
): T[number] | undefined {
  return input[key] === undefined ? undefined : requiredEnum(input, key, values, code);
}

export function requiredUuid(input: Record<string, unknown>, key: string, code: string, label: string): string {
  const value = requiredString(input, key, code, "00000000-0000-4000-8000-000000000001");
  if (!UUID_PATTERN.test(value)) {
    toolInputError(code, `Поле ${key} должно быть UUID существующего объекта: ${label}`);
  }
  return value;
}

export function requiredIsoDate(input: Record<string, unknown>, key: string, code: string): Date {
  const value = requiredString(input, key, code, "2026-08-01T10:00:00+03:00");
  if (!ISO_OFFSET_PATTERN.test(value)) {
    toolInputError(code, `Поле ${key} должно быть ISO datetime с UTC offset, например 2026-08-01T10:00:00+03:00`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    toolInputError(code, `Поле ${key} содержит некорректную дату. Пример: 2026-08-01T10:00:00+03:00`);
  }
  return date;
}

export function optionalIsoDate(input: Record<string, unknown>, key: string, code: string): Date | undefined {
  return input[key] === undefined ? undefined : requiredIsoDate(input, key, code);
}

export function requiredObjectField(
  input: Record<string, unknown>,
  key: string,
  code: string,
  message: string,
): Record<string, unknown> {
  const value = input[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    toolInputError(code, message);
  }
  return value as Record<string, unknown>;
}
