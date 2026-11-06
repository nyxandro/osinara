/**
 * Press data of widgets.
 *
 * Constructs covered:
 * - The press format the widget's script writes is read back exactly; anything else is not a press.
 * - The person's marks rebuild the data model the action's context reads.
 * - Property: for any marks, packing them the way the widget does and parsing gives them back.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ChoiceSlot } from "./a2ui/render.js";
import { parseWidgetQueryData, pressedDataModel } from "./widget-query-data.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** The widget's own `pack` (render-runtime.ts), restated to check the server reads what it writes. */
function pack(bits: string): string {
  let out = "";
  for (let index = 0; index < bits.length; index += 6) out += ALPHABET[parseInt(bits.slice(index, index + 6).padEnd(6, "0"), 2)];
  return out;
}

describe("widget press data", () => {
  it("reads an action press with marks, and a quiz score", () => {
    expect(parseWidgetQueryData(`a0.0.${pack("010000")}`, 6)).toEqual({ actionIndex: 0, bits: "010000", revision: 0, score: null });
    expect(parseWidgetQueryData("a2.7..9", 0)).toEqual({ actionIndex: 2, bits: "", revision: 7, score: 9 });
  });

  it("refuses data that is not a press of this widget", () => {
    expect(parseWidgetQueryData("tap:1", 0)).toBeNull();
    expect(parseWidgetQueryData("a0.0.AA", 6)).toBeNull();
    expect(parseWidgetQueryData(`a0.0.${"A".repeat(60)}`, 360)).toBeNull();
  });

  it("rebuilds the data model with the person's marks", () => {
    const slots: ChoiceSlot[] = [
      { bit: 0, kind: "option", path: "/picked", value: "borsch" },
      { bit: 1, kind: "option", path: "/picked", value: "plov" },
      { bit: 2, kind: "option", path: "/picked", value: "fish" },
      { bit: 3, kind: "boolean", path: "/steps/s1", value: null },
    ];
    expect(pressedDataModel({ picked: ["fish"], steps: { s1: false }, title: "Меню" }, slots, "1101")).toEqual({
      picked: ["borsch", "plov"],
      steps: { s1: true },
      title: "Меню",
    });
  });

  it("gives back any marks the widget packed", () => {
    fc.assert(fc.property(fc.array(fc.constantFrom("0", "1"), { maxLength: 120, minLength: 0 }).map((bits) => bits.join("")), fc.nat({ max: 7 }), fc.nat({ max: 999_999 }), (bits, action, revision) => {
      expect(parseWidgetQueryData(`a${action}.${revision}.${pack(bits)}`, bits.length)).toEqual({ actionIndex: action, bits, revision, score: null });
    }), { examples: [["", 0, 0], ["1".repeat(120), 7, 999_999], ["000001", 1, 1]] });
  });
});
