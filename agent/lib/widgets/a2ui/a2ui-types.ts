/**
 * A2UI 1.0 shapes the widget code shares: a checked surface, its components, values and errors.
 *
 * Exports:
 * - `A2UI_VERSION`: the protocol version every message carries.
 * - `A2uiError`, `A2uiErrorCode`: the protocol's standard validation error, returned to the model.
 * - `WidgetSurface`, `WidgetComponent`: a `createSurface` that passed validation.
 * - `JsonValue`, `JsonObject`: plain JSON data of the data model.
 * - `isRecord`, `isPathBinding`, `isFunctionCall`: the protocol's directive checks.
 * - `parsePointer`, `readPointer`, `writePointer`: JSON Pointer (RFC 6901) over the data model.
 *
 * Key constructs:
 * - A value is a literal, `{ "@path": pointer }` or `{ "@call": name, "args": {...} }`. A pointer
 *   starting with `/` is absolute; without it, it is relative to the item of a list template.
 * - The validation error keeps the protocol's fields (`code`, `surfaceId`, `path`, `message`) so the
 *   model reads errors in the same terms it writes the surface in.
 */

export const A2UI_VERSION = "1.0";

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type A2uiErrorCode = "VALIDATION_FAILED" | "UNALLOWED_PARENT" | "UNALLOWED_CHILD" | "INTEGRITY_ERROR";

export interface A2uiError {
  readonly code: A2uiErrorCode;
  readonly message: string;
  /** JSON Pointer into the message the model sent, such as `/createSurface/components/3/text`. */
  readonly path: string;
  readonly surfaceId: string;
}

export interface WidgetComponent {
  readonly component: string;
  readonly id: string;
  readonly props: Readonly<Record<string, unknown>>;
}

export interface WidgetSurface {
  readonly catalogId: string;
  readonly components: ReadonlyMap<string, WidgetComponent>;
  readonly dataModel: JsonObject;
  readonly sendDataModel: boolean;
  readonly surfaceId: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isPathBinding(value: unknown): value is { readonly "@path": string } {
  return isRecord(value) && typeof value["@path"] === "string" && Object.keys(value).length === 1;
}

export function isFunctionCall(value: unknown): value is { readonly "@call": string; readonly args?: Record<string, unknown> } {
  return isRecord(value) && typeof value["@call"] === "string";
}

/** The reference tokens of a pointer; `null` when it is not a valid RFC 6901 pointer. */
export function parsePointer(pointer: string): string[] | null {
  if (pointer === "" || pointer === "/") return [];
  const body = pointer.startsWith("/") ? pointer.slice(1) : pointer;
  const tokens = body.split("/");
  if (tokens.some((token) => token === "" || /~(?![01])/u.test(token))) return null;
  return tokens.map((token) => token.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

export function readPointer(root: JsonValue | undefined, tokens: readonly string[]): JsonValue | undefined {
  let current: JsonValue | undefined = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/u.test(token)) return undefined;
      current = (current as readonly JsonValue[])[Number(token)];
    } else if (isRecord(current)) {
      current = (current as JsonObject)[token];
    } else {
      return undefined;
    }
  }
  return current;
}

/** A copy of `root` with `value` at `tokens`; `null` deletes the key, as `updateDataModel` defines. */
export function writePointer(root: JsonObject, tokens: readonly string[], value: JsonValue): JsonObject {
  if (tokens.length === 0) {
    if (!isRecord(value)) throw new Error("A2UI_ROOT_NOT_OBJECT: the data model root must be an object");
    return value as JsonObject;
  }
  const [head, ...rest] = tokens as [string, ...string[]];
  const container: JsonValue | undefined = root[head];
  if (rest.length === 0) {
    const copy: Record<string, JsonValue> = { ...root };
    if (value === null) delete copy[head];
    else copy[head] = value;
    return copy;
  }
  if (Array.isArray(container)) {
    const index = rest[0] === undefined ? NaN : Number(rest[0]);
    if (!Number.isInteger(index) || index < 0 || index > container.length) {
      throw new Error(`A2UI_POINTER_INDEX_INVALID: ${rest[0]} is not an index of /${head}`);
    }
    const items = [...(container as readonly JsonValue[])];
    const inner = rest.slice(1);
    if (inner.length === 0) {
      if (value === null) items.splice(index, 1);
      else items[index] = value;
    } else {
      const item = items[index];
      if (!isRecord(item)) throw new Error(`A2UI_POINTER_TARGET_INVALID: /${head}/${index} is not an object`);
      items[index] = writePointer(item as JsonObject, inner, value);
    }
    return { ...root, [head]: items };
  }
  const child: JsonObject = isRecord(container) ? container as JsonObject : {};
  return { ...root, [head]: writePointer(child, rest, value) };
}
