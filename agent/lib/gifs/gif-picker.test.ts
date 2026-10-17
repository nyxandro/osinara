/**
 * GIF picker tests.
 *
 * Constructs covered:
 * - The vision model receives the brief as quoted data, the candidate count and the sheet as JPEG.
 * - A choice within the sheet comes back with its description; "none" comes back as no choice.
 * - An answer outside the agreed format, out of range or without a description is refused, and a
 *   provider failure keeps its cause.
 */
import { describe, expect, it, vi } from "vitest";

import { createGifPicker } from "./gif-picker.js";

const SHEET = new Uint8Array([0xff, 0xd8, 0xff]);

function picker(answer: string | Error) {
  const analyze = answer instanceof Error
    ? vi.fn().mockRejectedValue(answer)
    : vi.fn().mockResolvedValue(answer);
  return { analyze, pick: createGifPicker({ analyze }).pick };
}

const INPUT = { brief: "дерзкий ответ на «ну ты и тупая», грубый жест допустим", count: 6, sheet: SHEET };

describe("GIF picker", () => {
  it("shows the sheet with the brief as quoted data", async () => {
    const { analyze, pick } = picker('{"choice":2,"description":"робот показывает средний палец"}');

    await pick(INPUT);

    const request = analyze.mock.calls[0]![0] as { bytes: Uint8Array; mediaType: string; question: string };
    expect(request.bytes).toBe(SHEET);
    expect(request.mediaType).toBe("image/jpeg");
    expect(request.question).toContain("<reply_brief>\nдерзкий ответ на «ну ты и тупая», грубый жест допустим\n</reply_brief>");
    expect(request.question).toContain("numbered 1 to 6");
  });

  it("returns the chosen number with its description", async () => {
    await expect(picker('{"choice":2,"description":"робот показывает средний палец"}').pick(INPUT))
      .resolves.toEqual({ choice: 2, description: "робот показывает средний палец" });
  });

  it("reads an answer wrapped in a code fence", async () => {
    await expect(picker('```json\n{"choice": 6, "description": "кот закатывает глаза"}\n```').pick(INPUT))
      .resolves.toEqual({ choice: 6, description: "кот закатывает глаза" });
  });

  it("returns no choice when nothing fits", async () => {
    await expect(picker('{"choice":null}').pick(INPUT)).resolves.toEqual({ choice: null });
  });

  it.each([
    ["a number outside the sheet", '{"choice":7,"description":"лишний"}'],
    ["zero", '{"choice":0,"description":"ноль"}'],
    ["a choice without a description", '{"choice":3}'],
    ["prose", "Мне больше нравится третья"],
  ])("refuses %s", async (_label, answer) => {
    await expect(picker(answer).pick(INPUT)).rejects.toMatchObject({ code: "AGENT_GIF_PICKER_RESPONSE_INVALID" });
  });

  it("keeps the provider failure as the cause", async () => {
    const providerFailure = new Error("upstream timeout");

    await expect(picker(providerFailure).pick(INPUT)).rejects.toMatchObject({
      cause: providerFailure,
      code: "AGENT_GIF_PICKER_FAILED",
    });
  });

  it("bounds every look at a sheet in time, together with the turn's own cancellation", async () => {
    const { analyze, pick } = picker('{"choice":null}');
    const turn = new AbortController();

    await pick({ ...INPUT, abortSignal: turn.signal });
    const signal = (analyze.mock.calls[0]![0] as { abortSignal: AbortSignal }).abortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    turn.abort();
    expect(signal.aborted).toBe(true);

    await pick(INPUT);
    expect((analyze.mock.calls[1]![0] as { abortSignal?: AbortSignal }).abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("never tells the person how the GIF is chosen", async () => {
    const failures = await Promise.all([
      picker(new Error("upstream timeout")).pick(INPUT).catch((error: unknown) => error),
      picker("prose").pick(INPUT).catch((error: unknown) => error),
    ]);

    for (const failure of failures) {
      expect((failure as Error).message).not.toMatch(/модел/iu);
    }
  });
});
