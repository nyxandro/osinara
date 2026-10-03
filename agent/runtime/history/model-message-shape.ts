/**
 * Shape check for conversation history before it is stored or imported.
 *
 * Exports:
 * - `describeHistoryProblem`: why a value is not a storable AI SDK message list, or `null`.
 * - `firstNonJsonPath`: where a value stops being plain JSON, or `null`.
 *
 * Storable means: every entry has a known role and string or part-list content, and every value
 * is plain JSON. Bytes, dates, maps or non-finite numbers would not survive the `json` column,
 * so they are reported instead of being silently lost.
 */
import { isObject } from "../json.js";

const MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);

export function firstNonJsonPath(value: unknown, path: string): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : path;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = firstNonJsonPath(item, `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }
  // devalue restores a prototype-less object as such; for JSON it is an ordinary object.
  const prototype = typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (prototype !== Object.prototype && prototype !== null) return path;
  for (const [key, item] of Object.entries(value as object)) {
    if (item === undefined) continue;
    const found = firstNonJsonPath(item, `${path}.${key}`);
    if (found !== null) return found;
  }
  return null;
}

export function describeHistoryProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return "история не является списком сообщений";
  for (const [index, message] of value.entries()) {
    if (!isObject(message) || typeof message.role !== "string" || !MESSAGE_ROLES.has(message.role)) {
      return `сообщение ${index} не является сообщением модели`;
    }
    const content = message.content;
    const validContent = typeof content === "string" ||
      (Array.isArray(content) && content.every((part) => isObject(part) && typeof part.type === "string"));
    if (!validContent) return `у сообщения ${index} неверное содержимое`;
  }
  const path = firstNonJsonPath(value, "history");
  return path === null ? null : `значение особого типа в ${path}`;
}
