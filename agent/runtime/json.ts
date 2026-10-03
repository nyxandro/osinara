/**
 * JSON values that cross the runtime boundary: Telegram bodies, tool payloads, journal records.
 *
 * Exports:
 * - `JsonValue`, `JsonObject`: JSON-serializable shapes.
 * - `parseJsonObject`: normalizes an option bag into a JSON object, dropping `undefined` fields.
 * - `isObject`, `isNonEmptyString`: guards for duck-typing untrusted payloads.
 *
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
export type JsonPrimitive = boolean | number | string | null;
export type JsonArray = readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

const INVALID = Symbol("invalid-json-value");

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

// `undefined` properties count as omitted; Date, Map, NaN and cycles are rejected as lossy.
function normalize(value: unknown, seen: WeakSet<object>): JsonValue | typeof INVALID {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : INVALID;
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const normalized = normalize(item, seen);
      if (normalized === INVALID) return INVALID;
      items.push(normalized);
    }
    return items;
  }
  if (typeof value !== "object" || !isPlainObject(value) || seen.has(value)) return INVALID;
  seen.add(value);
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    const normalized = normalize(entry, seen);
    if (normalized === INVALID) return INVALID;
    result[key] = normalized;
  }
  seen.delete(value);
  return result;
}

export function parseJsonObject(value: unknown): JsonObject {
  const normalized = normalize(value, new WeakSet());
  if (normalized === INVALID) throw new TypeError("Expected a JSON-serializable value.");
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
    throw new TypeError("Expected a JSON-serializable object.");
  }
  return normalized as JsonObject;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
