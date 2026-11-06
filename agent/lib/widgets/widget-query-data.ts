/**
 * The data a widget press carries, and the A2UI action it stands for.
 *
 * Exports:
 * - `WidgetQueryData`: a parsed press: which action, at which revision, the choice bits, a quiz score.
 * - `parseWidgetQueryData`: the press data, or `null` when it is not a press of our widgets.
 * - `pressedDataModel`: the data model with the person's check marks and options applied.
 *
 * Key constructs:
 * - The data is `a<action>.<revision>.<bits>[.<score>]` (`render-runtime.ts` writes it): at most 64
 *   bytes, written by the client, so it says only which action and which marks. What the action means
 *   — its name, label and context — comes from the stored widget, never from the client.
 * - Bits are six per character of the base64url alphabet, the same alphabet the widget's `pack` uses.
 */
import { type JsonObject, type JsonValue, parsePointer, writePointer } from "./a2ui/a2ui-types.js";
import type { ChoiceSlot } from "./a2ui/render.js";
import { WIDGET_QUERY_DATA_MAX_BYTES } from "./widget-config.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const PRESS = /^a(\d{1,2})\.(\d{1,9})\.([A-Za-z0-9_-]{0,40})(?:\.(\d{1,3}))?$/u;

export interface WidgetQueryData {
  readonly actionIndex: number;
  readonly bits: string;
  readonly revision: number;
  readonly score: number | null;
}

export function parseWidgetQueryData(data: string, slotCount: number): WidgetQueryData | null {
  if (Buffer.byteLength(data, "utf8") > WIDGET_QUERY_DATA_MAX_BYTES) return null;
  const match = PRESS.exec(data);
  if (match === null) return null;
  const packed = match[3]!;
  if (packed.length !== Math.ceil(slotCount / 6)) return null;
  const bits = [...packed].map((character) => ALPHABET.indexOf(character).toString(2).padStart(6, "0")).join("").slice(0, slotCount);
  return {
    actionIndex: Number(match[1]),
    bits,
    revision: Number(match[2]),
    score: match[4] === undefined ? null : Number(match[4]),
  };
}

/** The data model as the person saw it at the press: each input's value set from the bits. */
export function pressedDataModel(dataModel: JsonObject, slots: readonly ChoiceSlot[], bits: string): JsonObject {
  const values = new Map<string, JsonValue>();
  for (const slot of slots) {
    const on = bits[slot.bit] === "1";
    if (slot.kind === "boolean") {
      values.set(slot.path, on);
    } else {
      const picked = (values.get(slot.path) as string[] | undefined) ?? [];
      values.set(slot.path, on ? [...picked, slot.value!] : picked);
    }
  }
  let result = dataModel;
  for (const [path, value] of values) result = writePointer(result, parsePointer(path)!, value);
  return result;
}
