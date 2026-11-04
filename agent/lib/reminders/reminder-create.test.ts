/**
 * The replay fingerprint of a reminder created at an exact moment (#451).
 *
 * Constructs covered:
 * - The fingerprint keeps the key order the tool used before #451, so a create interrupted by a
 *   restart across the release is answered with its reminder instead of an operation conflict.
 */
import { describe, expect, it } from "vitest";

import { createOperationHash } from "./reminder-create.js";
import { reminderOperationHash } from "./reminder-record.js";

describe("createOperationHash", () => {
  it("matches the fingerprint of an exact moment written before #451", () => {
    const buttons = [[{ text: "✅ Оплатил" }]];
    const recurrence = { interval: 1, unit: "monthly" as const };
    // The tool passed {buttons, content, firstRunAt, recurrence, scope, timezone} and appended operationKey.
    const before = reminderOperationHash({
      buttons, content: "Оплатить интернет", firstRunAt: "2026-11-05T07:00:00.000Z", recurrence,
      scope: "personal", timezone: "Europe/Moscow", operationKey: "call-1",
    });
    expect(createOperationHash({
      buttons, content: " Оплатить интернет ", operationKey: "call-1", recurrence, scope: "personal",
      time: { at: new Date("2026-11-05T10:00:00+03:00"), kind: "absolute", timezone: "Europe/Moscow" },
    }, "Оплатить интернет")).toBe(before);
  });
});
