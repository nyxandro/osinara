import type { ModelMessage } from "ai";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../lib/app-error.js";
import type { CompactionCounters } from "../history/history-repository.js";
import { estimateTokens } from "./compaction-estimate.js";
import {
  compactionSettings, compactMessages, shouldCompact, todoCompactionMessage, type PromptMeasurement, type Summarize,
} from "./compaction.js";

const NO_COUNTERS = { inputTokens: null, promptMessageCount: null };
const UNMEASURED: PromptMeasurement = { counters: NO_COUNTERS, frameTokens: 0 };
// Compaction runs before a model call, so the prompt ends with the person's message.
const CURRENT: ModelMessage = { role: "user", content: "текущий вопрос" };

function exchange(index: number, size = 50): ModelMessage[] {
  return [
    { role: "user", content: `вопрос ${index} ${"x".repeat(size)}` },
    { role: "assistant", content: [{ type: "text", text: `ответ ${index} ${"y".repeat(size)}` }] },
  ];
}

function toolExchange(index: number, resultSize: number, letter = "z"): ModelMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: `c${index}`, toolName: "bash", input: { command: "cat" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: `c${index}`, toolName: "bash", output: { type: "text", value: letter.repeat(resultSize) } }] },
  ];
}

// A provider that counts the first `count` messages and the frame at `percent` of their estimate.
function providerCount(messages: readonly ModelMessage[], count: number, frameTokens: number, percent: number): CompactionCounters {
  return { inputTokens: Math.round((estimateTokens(messages.slice(0, count)) + frameTokens) * percent / 100), promptMessageCount: count };
}

// The next step's decision: the replaced history has no provider count yet, the frame is the same.
function compactsAgain(compacted: readonly ModelMessage[], settings: { recentWindowSize: number; threshold: number }, frameTokens: number): boolean {
  return shouldCompact(compacted, settings, { counters: NO_COUNTERS, frameTokens });
}

const LETTERS = ["x", "я"] as const;

// History as a conversation carries it: Latin and Russian text, tool results up to 20k, an
// optional checkpoint of an earlier compaction, and usually the person's message last.
const conversationArbitrary = fc.record({
  checkpoint: fc.option(fc.integer({ max: 3_000, min: 1 }), { nil: undefined }),
  chunks: fc.array(fc.oneof(
    fc.record({ kind: fc.constant("exchange" as const), letter: fc.constantFrom(...LETTERS), size: fc.integer({ max: 3_000, min: 0 }) }),
    fc.record({ kind: fc.constant("tool" as const), letter: fc.constantFrom(...LETTERS), size: fc.integer({ max: 20_000, min: 0 }) }),
  ), { maxLength: 30 }),
  endsWithPerson: fc.boolean(),
}).map(({ checkpoint, chunks, endsWithPerson }): ModelMessage[] => [
  ...(checkpoint === undefined ? [] : [
    { role: "user" as const, content: "Summary of our conversation so far:" },
    { role: "assistant" as const, content: "с".repeat(checkpoint) },
  ]),
  ...chunks.flatMap((chunk, index) => chunk.kind === "exchange"
    ? [
      { role: "user" as const, content: `вопрос ${index} ${chunk.letter.repeat(chunk.size)}` },
      { role: "assistant" as const, content: [{ type: "text" as const, text: `ответ ${index} ${chunk.letter.repeat(chunk.size)}` }] },
    ]
    : toolExchange(index, chunk.size, chunk.letter)),
  ...(endsWithPerson ? [CURRENT] : []),
]);

// In proportions a deployment has: the frame up to 30% of the threshold, a summary up to 20%. The
// provider counts between 80% and 150% of the estimate, as tokenizers and stored reasoning differ.
const promptArbitrary = conversationArbitrary.chain((messages) => fc.integer({ max: 30_000, min: 1_000 }).chain((threshold) => fc.record({
  measurement: fc.integer({ max: 30, min: 0 }).map((percent) => Math.floor(threshold * percent / 100)).chain((frameTokens) => fc.option(
    fc.record({ count: fc.integer({ max: messages.length, min: 0 }), percent: fc.integer({ max: 150, min: 80 }) })
      .map(({ count, percent }) => providerCount(messages, count, frameTokens, percent)),
    // Every replacement leaves the history unmeasured until the next model call: half the cases.
    { freq: 1, nil: NO_COUNTERS },
  ).map((counters): PromptMeasurement => ({ counters, frameTokens }))),
  messages: fc.constant(messages),
  settings: fc.record({ recentWindowSize: fc.integer({ max: 10, min: 1 }), threshold: fc.constant(threshold) }),
  summary: fc.integer({ max: Math.floor(threshold * 0.4), min: 0 }).map((letters) => "с".repeat(letters)),
})));

// Production, 5 October 2026, scaled down: the provider counted the history and the frame a fifth
// over their estimate, the estimate without the frame put the prompt under the threshold, and
// capping had nothing left to cut. After the model refused the prompt, the same history stayed
// without a provider count.
const productionLoop = (() => {
  const messages = [...Array.from({ length: 50 }, (_, index) => exchange(index, 300)).flat(), CURRENT];
  const frameTokens = 1_300;
  return {
    measurement: { counters: providerCount(messages, messages.length - 1, frameTokens, 120), frameTokens },
    messages,
    settings: { recentWindowSize: 10, threshold: 10_000 },
    summary: "сводка",
  };
})();

describe("history compaction", () => {
  it("compacts once the provider-reported prompt plus what came after passes the threshold", () => {
    const settings = compactionSettings(10_000, 0.75);
    const messages = exchange(1);

    expect(settings).toEqual({ recentWindowSize: 10, threshold: 7_500 });
    expect(shouldCompact(messages, settings, UNMEASURED)).toBe(false);
    expect(shouldCompact(messages, settings, { counters: { inputTokens: 7_400, promptMessageCount: 1 }, frameTokens: 0 })).toBe(true);
    expect(shouldCompact(messages, settings, { counters: { inputTokens: 7_400, promptMessageCount: 5 }, frameTokens: 0 })).toBe(false);
  });

  it("measures Russian text by its UTF-8 size, as the provider counts it, not by its letters", () => {
    const settings = { recentWindowSize: 10, threshold: 4_000 };

    // 10 000 letters: under the threshold at four letters a token, over it at four bytes.
    expect(shouldCompact([{ role: "user", content: "я".repeat(10_000) }], settings, UNMEASURED)).toBe(true);
    expect(shouldCompact([{ role: "user", content: "x".repeat(10_000) }], settings, UNMEASURED)).toBe(false);
  });

  it("counts the system prompt and tool definitions of a history the provider has not measured", async () => {
    const { messages, settings } = productionLoop;
    const measurement = { counters: NO_COUNTERS, frameTokens: 1_300 };
    const summarize = vi.fn<Summarize>(async () => "сводка");
    expect(shouldCompact(messages, settings, UNMEASURED)).toBe(false);
    expect(shouldCompact(messages, settings, measurement)).toBe(true);

    const compacted = await compactMessages(messages, settings, summarize, measurement);

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(compactsAgain(compacted, settings, measurement.frameTokens)).toBe(false);
  });

  it("summarizes when the provider measured the prompt over the threshold and capping has nothing to cut", async () => {
    const { messages, settings } = productionLoop;
    const measurement = { counters: providerCount(messages, messages.length - 1, 0, 120), frameTokens: 0 };
    const summarize = vi.fn<Summarize>(async () => "сводка");
    expect(shouldCompact(messages, settings, UNMEASURED)).toBe(false);
    expect(shouldCompact(messages, settings, measurement)).toBe(true);

    const compacted = await compactMessages(messages, settings, summarize, measurement);

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(compacted.slice(0, 2)).toEqual([
      { role: "user", content: "Summary of our conversation so far:" },
      { role: "assistant", content: "сводка" },
    ]);
    expect(compactsAgain(compacted, settings, measurement.frameTokens)).toBe(false);
  });

  it("leaves a history the next step does not compact again, or fails with a coded error", async () => {
    await fc.assert(fc.asyncProperty(promptArbitrary, async ({ measurement, messages, settings, summary }) => {
      // The turn compacts only what `shouldCompact` asked for.
      fc.pre(shouldCompact(messages, settings, measurement));
      let compacted: ModelMessage[];
      try {
        compacted = await compactMessages(messages, settings, async () => summary, measurement);
      } catch (error) {
        if (error instanceof AppError && error.code === "AGENT_COMPACTION_OUTPUT_TOO_LARGE") return;
        throw error;
      }
      // A provider that counts what the estimate counts finds the request within the threshold.
      expect(estimateTokens(compacted) + measurement.frameTokens).toBeLessThanOrEqual(settings.threshold);
      expect(compactsAgain(compacted, settings, measurement.frameTokens)).toBe(false);
    }), { examples: [[productionLoop], [{ ...productionLoop, measurement: { counters: NO_COUNTERS, frameTokens: productionLoop.measurement.frameTokens } }]] });
  });

  it("caps old tool results without a summary call when that is enough", async () => {
    const summarize = vi.fn<Summarize>(async () => "сводка");
    const messages = [...exchange(0), ...toolExchange(1, 20_000), ...exchange(2), ...exchange(3), ...exchange(4), ...exchange(5), ...exchange(6), CURRENT];

    const compacted = await compactMessages(messages, { recentWindowSize: 10, threshold: 2_400 }, summarize, UNMEASURED);

    expect(summarize).not.toHaveBeenCalled();
    expect(compacted[3]).toMatchObject({ role: "tool", content: [{ output: { type: "text", value: expect.stringMatching(/^\[Truncated: /) } }] });
    expect(compacted.slice(-10)).toEqual(messages.slice(-10));
    expect(compacted).toHaveLength(messages.length);
  });

  it("replaces the older part with one checkpoint and keeps the recent tail verbatim", async () => {
    const summarize = vi.fn<Summarize>(async () => "Сделано: A. Осталось: B.");
    const messages = [...Array.from({ length: 20 }, (_, index) => exchange(index, 400)).flat(), CURRENT];

    const compacted = await compactMessages(messages, { recentWindowSize: 4, threshold: 2_000 }, summarize, UNMEASURED);

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0]![0]).toMatchObject({
      prompt: expect.stringContaining("<previous-checkpoint>\n(none)\n</previous-checkpoint>"),
      system: expect.stringMatching(/^You are performing a CONTEXT CHECKPOINT COMPACTION\./),
    });
    expect(compacted.slice(0, 2)).toEqual([
      { role: "user", content: "Summary of our conversation so far:" },
      { role: "assistant", content: "Сделано: A. Осталось: B." },
    ]);
    expect(compacted.slice(2)).toEqual(messages.slice(-4));
  });

  it("asks the model to continue when the kept part would end on its own answer", async () => {
    const messages = Array.from({ length: 20 }, (_, index) => exchange(index, 400)).flat();

    const compacted = await compactMessages(messages, { recentWindowSize: 4, threshold: 2_000 }, async () => "сводка", UNMEASURED);

    expect(compacted.at(-1)).toEqual({ role: "user", content: "Continue." });
  });

  it("folds a previous checkpoint into the next summary", async () => {
    const summarize = vi.fn<Summarize>(async () => "новая сводка");
    const messages: ModelMessage[] = [
      { role: "user", content: "Summary of our conversation so far:" },
      { role: "assistant", content: "старая сводка" },
      ...Array.from({ length: 12 }, (_, index) => exchange(index, 400)).flat(),
      CURRENT,
    ];

    await compactMessages(messages, { recentWindowSize: 2, threshold: 2_000 }, summarize, UNMEASURED);

    expect(summarize.mock.calls[0]![0].prompt).toContain("<previous-checkpoint>\nстарая сводка\n</previous-checkpoint>");
  });

  it("fails with a coded error instead of a second summary call when the result does not fit", async () => {
    const summarize = vi.fn<Summarize>(async () => "s".repeat(40_000));
    const messages = Array.from({ length: 8 }, (_, index) => exchange(index, 2_000)).flat();

    await expect(compactMessages(messages, { recentWindowSize: 4, threshold: 6_000 }, summarize, UNMEASURED))
      .rejects.toMatchObject({ code: "AGENT_COMPACTION_OUTPUT_TOO_LARGE" });
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("re-adds an open task list, and nothing for a finished one", () => {
    expect(todoCompactionMessage({ items: [
      { content: "проверить", priority: "high", status: "in_progress" },
      { content: "готово", priority: "low", status: "completed" },
      { content: "не надо", priority: "medium", status: "cancelled" },
    ] })).toEqual({ role: "user", content: [
      "[Your task list was preserved across context compaction]",
      "- [ ] [high] проверить",
      "- [x] [low] готово",
      "- [-] [medium] не надо",
    ].join("\n") });
    expect(todoCompactionMessage({ items: [{ content: "готово", priority: "low", status: "completed" }] })).toBeUndefined();
    expect(todoCompactionMessage(null)).toBeUndefined();
  });
});
