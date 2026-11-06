/**
 * Applying the agent's A2UI `updateDataModel` messages to a widget already in the chat.
 *
 * Exports:
 * - `WidgetUpdateResult`: the new data model and the shared state to send, or why it cannot be done.
 * - `applyWidgetUpdates`: the messages applied to one stored widget.
 * - `progressPercent`: the width of a progress bar, shared with the renderer.
 *
 * Key constructs:
 * - The widget's HTML never changes after sending, so an update reaches it only as its shared state
 *   (`public_data`): `{ r, v, p }` — the new revision, the texts of bound elements and the widths of
 *   bound progress bars. Only values that differ from what the HTML shows are sent, so the state stays
 *   within Telegram's 1024 bytes as long as possible.
 * - An update that changes what was frozen when the widget was built — a table, a chart, an input's
 *   initial state, the length of a list — is refused as a whole: the widget would keep showing the old
 *   picture while the agent believes it changed. The agent then sends a new widget.
 */
import { WIDGET_PUBLIC_DATA_MAX_BYTES } from "../widget-config.js";
import type { StoredWidget } from "../widget-repository.js";
import {
  A2UI_VERSION,
  type JsonObject,
  type JsonValue,
  isRecord,
  parsePointer,
  readPointer,
  writePointer,
} from "./a2ui-types.js";
import { evaluateNumber, evaluateString, WidgetEvaluationError } from "./evaluate.js";

const UPDATES_MAX = 10;

export type WidgetUpdateResult =
  | { readonly ok: true; readonly dataModel: JsonObject; readonly publicData: string | null; readonly visibleChanges: number }
  | { readonly ok: false; readonly code: "AGENT_WIDGET_UPDATE_INVALID" | "AGENT_WIDGET_NOT_UPDATABLE"; readonly reason: string };

export function progressPercent(value: number, max: number): number {
  return Math.round(Math.min(100, Math.max(0, max > 0 ? (value / max) * 100 : 0)));
}

function invalid(reason: string): WidgetUpdateResult {
  return { code: "AGENT_WIDGET_UPDATE_INVALID", ok: false, reason };
}

function notUpdatable(reason: string): WidgetUpdateResult {
  return { code: "AGENT_WIDGET_NOT_UPDATABLE", ok: false, reason };
}

function sameJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function applyWidgetUpdates(widget: StoredWidget, messages: unknown): WidgetUpdateResult {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > UPDATES_MAX) {
    return invalid(`send 1-${UPDATES_MAX} A2UI messages { "version": "1.0", "updateDataModel": { surfaceId, path, value } }`);
  }
  let dataModel = widget.dataModel;
  for (const [position, message] of messages.entries()) {
    const update = isRecord(message) ? message.updateDataModel : undefined;
    if (!isRecord(message) || message.version !== A2UI_VERSION || !isRecord(update) || Object.keys(message).length !== 2) {
      return invalid(`message ${position} is not { "version": "1.0", "updateDataModel": {...} }`);
    }
    if (update.surfaceId !== widget.surfaceId) return invalid(`message ${position} names surfaceId "${String(update.surfaceId)}", not "${widget.surfaceId}"`);
    const path = update.path ?? "/";
    const tokens = typeof path === "string" && (path === "/" || path.startsWith("/")) ? parsePointer(path) : null;
    if (tokens === null) return invalid(`message ${position}: path is an absolute JSON Pointer such as /going`);
    if (!("value" in update)) return invalid(`message ${position}: value is required (null deletes)`);
    try {
      dataModel = writePointer(dataModel, tokens, update.value as JsonValue);
    } catch (error) {
      return invalid(`message ${position}: ${error instanceof Error ? error.message.replace(/^[A-Z0-9_]+: /u, "") : String(error)}`);
    }
  }
  for (const frozen of widget.surface.frozen) {
    const tokens = parsePointer(frozen.pointer)!;
    const before = readPointer(widget.dataModel, tokens);
    const after = readPointer(dataModel, tokens);
    const changed = frozen.kind === "length"
      ? !Array.isArray(after) || (Array.isArray(before) && before.length !== after.length)
      : !sameJson(before, after);
    if (changed) {
      return notUpdatable(frozen.kind === "length"
        ? `the number of items at ${frozen.pointer} is fixed once the widget is sent: send a new widget`
        : `${frozen.pointer} is drawn into the widget (a table, a chart, an input or a label) and cannot change: send a new widget`);
    }
  }
  const texts: Record<string, string> = {};
  const widths: Record<string, number> = {};
  try {
    for (const binding of widget.surface.bindings) {
      const scope = { dataModel, item: binding.item, reads: new Set<string>() };
      if (binding.kind === "text") {
        const shown = evaluateString(binding.value, scope, binding.field);
        if (shown !== widget.surface.baked[binding.node]) texts[binding.node] = shown;
      } else {
        const max = typeof binding.max === "number" ? binding.max : evaluateNumber(binding.max, scope, `${binding.field}/max`);
        const width = progressPercent(evaluateNumber(binding.value, scope, binding.field), max);
        if (width !== widget.surface.baked[binding.node]) widths[binding.node] = width;
      }
    }
  } catch (error) {
    if (error instanceof WidgetEvaluationError) return invalid(`${error.field}: ${error.message}`);
    throw error;
  }
  const visibleChanges = Object.keys(texts).length + Object.keys(widths).length;
  const previouslyShown = widget.revision > 0;
  if (visibleChanges === 0 && !previouslyShown) return { dataModel, ok: true, publicData: null, visibleChanges };
  const publicData = JSON.stringify({ p: widths, r: widget.revision + 1, v: texts });
  if (Buffer.byteLength(publicData, "utf8") > WIDGET_PUBLIC_DATA_MAX_BYTES) {
    return notUpdatable(`the changed texts take ${Buffer.byteLength(publicData, "utf8")} bytes, Telegram takes ${WIDGET_PUBLIC_DATA_MAX_BYTES}: send a new widget`);
  }
  return { dataModel, ok: true, publicData, visibleChanges };
}
