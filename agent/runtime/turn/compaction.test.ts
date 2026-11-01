import type { ModelMessage } from "ai";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../lib/app-error.js";
import type { CompactionCounters } from "../history/history-repository.js";
import { estimateTokens } from "./compaction-estimate.js";
import {
  capToolResults, compactionSettings, compactMessages, providerCountStatus, shouldCompact, todoCompactionMessage, type PromptMeasurement,
  type Summarize,
} from "./compaction.js";
import { COMPACTION_BRIEF_SUMMARY_WORD_LIMIT, COMPACTION_SUMMARY_WORD_LIMIT } from "./compaction-prompt.js";

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

function toolExchange(index: number, resultSize: number, letter = "z", kind: "json" | "text" = "text"): ModelMessage[] {
  const value = letter.repeat(resultSize);
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: `c${index}`, toolName: "bash", input: { command: "cat" } }] },
    { role: "tool", content: [{
      type: "tool-result", toolCallId: `c${index}`, toolName: "bash",
      output: kind === "text" ? { type: "text", value } : { type: "json", value: { exitCode: 0, stdout: value } },
    }] },
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
    fc.record({
      kind: fc.constant("tool" as const), letter: fc.constantFrom(...LETTERS), output: fc.constantFrom("json" as const, "text" as const),
      size: fc.integer({ max: 20_000, min: 0 }),
    }),
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
    : toolExchange(index, chunk.size, chunk.letter, chunk.output)),
  ...(endsWithPerson ? [CURRENT] : []),
]);

// In proportions a deployment has: the frame up to 30% of the threshold, a summary up to 20%. The
// provider counts between 50% and 150% of the estimate: tokenizers differ, and the stored reasoning
// the estimate counts never reaches a provider that drops it (production, 31.10.2026: 60%).
const promptArbitrary = conversationArbitrary.chain((messages) => fc.integer({ max: 30_000, min: 1_000 }).chain((threshold) => fc.record({
  measurement: fc.integer({ max: 30, min: 0 }).map((percent) => Math.floor(threshold * percent / 100)).chain((frameTokens) => fc.option(
    fc.record({ count: fc.integer({ max: messages.length, min: 0 }), percent: fc.integer({ max: 150, min: 50 }) })
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

  // Production, 31.10.2026: the estimate counted stored reasoning the provider never receives and ran
  // 60% over its count, so a private chat compacted at 141 000 of a 196 000 threshold.
  it("does not compact while the provider counts the history under the threshold, though the estimate is over it", () => {
    const settings = { recentWindowSize: 10, threshold: 10_000 };
    const messages = [...Array.from({ length: 60 }, (_, index) => exchange(index, 300)).flat(), CURRENT];
    const counted = messages.length - 1;
    expect(shouldCompact(messages, settings, UNMEASURED)).toBe(true);

    expect(shouldCompact(messages, settings, { counters: providerCount(messages, counted, 0, 60), frameTokens: 0 })).toBe(false);
    // What came after the measured request is still estimated and pushes it over.
    const grown = [...messages.slice(0, -1), ...Array.from({ length: 30 }, (_, index) => exchange(100 + index, 300)).flat(), CURRENT];
    expect(shouldCompact(grown, settings, { counters: providerCount(grown, counted, 0, 60), frameTokens: 0 })).toBe(true);
  });

  // An OpenAI-compatible adapter reports a missing prompt_tokens as 0: trusting it, the history would
  // never compact and would grow until the provider refused every message of the chat.
  it("treats a provider count under half the estimate of what it counted as no count at all", () => {
    const settings = { recentWindowSize: 10, threshold: 10_000 };
    const messages = [...Array.from({ length: 60 }, (_, index) => exchange(index, 300)).flat(), CURRENT];
    const counted = messages.length - 1;

    for (const percent of [0, 10, 49]) {
      const measurement = { counters: providerCount(messages, counted, 500, percent), frameTokens: 500 };
      expect(providerCountStatus(messages, measurement)).toBe("ignored");
      expect(shouldCompact(messages, settings, measurement)).toBe(true);
    }
    expect(providerCountStatus(messages, { counters: providerCount(messages, counted, 500, 60), frameTokens: 500 })).toBe("trusted");
    expect(providerCountStatus(messages, { counters: NO_COUNTERS, frameTokens: 500 })).toBe("absent");
  });

  it("decides on an untrusted provider count exactly as on no count", () => {
    fc.assert(fc.property(promptArbitrary, fc.integer({ max: 49, min: 0 }), ({ measurement, messages, settings }, percent) => {
      fc.pre(messages.length > 0);
      const counters = providerCount(messages, messages.length, measurement.frameTokens, percent);
      fc.pre(counters.inputTokens! < (estimateTokens(messages) + measurement.frameTokens) / 2);
      expect(shouldCompact(messages, settings, { counters, frameTokens: measurement.frameTokens }))
        .toBe(shouldCompact(messages, settings, { counters: NO_COUNTERS, frameTokens: measurement.frameTokens }));
    }));
  });

  // Before, the kept tail filled the whole budget: with large tool results in it, the next step's
  // result asked for a compaction again, a summary call and a cold cache every step or two.
  it("keeps a fifth of the threshold free after a summary, so the next tool result does not compact again", async () => {
    const settings = { recentWindowSize: 10, threshold: 40_000 };
    const messages = [
      ...Array.from({ length: 20 }, (_, index) => exchange(index, 300)).flat(),
      ...Array.from({ length: 8 }, (_, index) => toolExchange(100 + index, 36_000)).flat(),
      CURRENT,
    ];
    expect(shouldCompact(messages, settings, UNMEASURED)).toBe(true);

    const compacted = await compactMessages(messages, settings, async () => "сводка", UNMEASURED, 0);
    // A result of 15% of the threshold, like one page of `web_fetch` on a smaller window.
    const nextStep = [...compacted, ...toolExchange(200, 24_000)];

    expect(compactsAgain(nextStep, settings, 0)).toBe(false);
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

    const compacted = await compactMessages(messages, settings, summarize, measurement, 0);

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(compactsAgain(compacted, settings, measurement.frameTokens)).toBe(false);
  });

  it("leaves out of the summary what the application restates by itself after a compaction", async () => {
    const restated: ModelMessage = { role: "user", content: "<restated>факт, который потом отзовут</restated>" };
    const messages = [restated, ...productionLoop.messages];
    const settings = {
      ...productionLoop.settings,
      restatedAfterCompaction: (message: ModelMessage) =>
        typeof message.content === "string" && message.content.startsWith("<restated>"),
    };
    const measurement = { counters: providerCount(messages, messages.length - 1, 0, 120), frameTokens: 0 };
    const summarize = vi.fn<Summarize>(async () => "сводка");

    const compacted = await compactMessages(messages, settings, summarize, measurement, 0);

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0]![0].prompt).not.toContain("факт, который потом отзовут");
    expect(JSON.stringify(compacted)).not.toContain("факт, который потом отзовут");
  });

  it("summarizes when the provider measured the prompt over the threshold and capping has nothing to cut", async () => {
    const { messages, settings } = productionLoop;
    const measurement = { counters: providerCount(messages, messages.length - 1, 0, 120), frameTokens: 0 };
    const summarize = vi.fn<Summarize>(async () => "сводка");
    expect(shouldCompact(messages, settings, UNMEASURED)).toBe(false);
    expect(shouldCompact(messages, settings, measurement)).toBe(true);

    const compacted = await compactMessages(messages, settings, summarize, measurement, 0);

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
        compacted = await compactMessages(messages, settings, async () => summary, measurement, 0);
      } catch (error) {
        if (error instanceof AppError && error.code === "AGENT_COMPACTION_OUTPUT_TOO_LARGE") return;
        throw error;
      }
      // A provider that counts what the estimate counts finds the request within the threshold.
      expect(estimateTokens(compacted) + measurement.frameTokens).toBeLessThanOrEqual(settings.threshold);
      expect(compactsAgain(compacted, settings, measurement.frameTokens)).toBe(false);
    }), { examples: [[productionLoop], [{ ...productionLoop, measurement: { counters: NO_COUNTERS, frameTokens: productionLoop.measurement.frameTokens } }]] });
  });

  // Production, 5 October 2026: 23 compactions re-capped the same results until no line of their
  // text was left, while each kept its 2 106 characters.
  it("caps a tool result once: a later compaction leaves it as it was", () => {
    const messages = [...exchange(0), ...toolExchange(1, 10_000, "я"), CURRENT];

    const capped = capToolResults(messages);

    expect(capped[3]).toMatchObject({ role: "tool", content: [{ output: { type: "text", value: expect.stringMatching(/^\[Truncated: [^]*яя$/) } }] });
    expect(capToolResults(capped)).toEqual(capped);
  });

  it("caps any history to the same result the second time as the first", () => {
    fc.assert(fc.property(conversationArbitrary, (messages) => {
      const once = capToolResults(messages);
      expect(capToolResults(once)).toEqual(once);
    }), { examples: [[[...toolExchange(1, 10_000, "я"), CURRENT]], [[...toolExchange(1, 10_000, "x", "json"), CURRENT]]] });
  });

  it("caps old tool results without a summary call when that is enough", async () => {
    const summarize = vi.fn<Summarize>(async () => "сводка");
    const messages = [...exchange(0), ...toolExchange(1, 20_000), ...exchange(2), ...exchange(3), ...exchange(4), ...exchange(5), ...exchange(6), CURRENT];

    const compacted = await compactMessages(messages, { recentWindowSize: 10, threshold: 2_400 }, summarize, UNMEASURED, 0);

    expect(summarize).not.toHaveBeenCalled();
    expect(compacted[3]).toMatchObject({ role: "tool", content: [{ output: { type: "text", value: expect.stringMatching(/^\[Truncated: /) } }] });
    expect(compacted.slice(-10)).toEqual(messages.slice(-10));
    expect(compacted).toHaveLength(messages.length);
  });

  // Production, 21–31.10.2026: 17 of 26 compactions only capped old tool results, freed almost nothing
  // and broke the provider's cache; a summary followed one to eleven steps later.
  it("summarizes instead of capping when the cap would leave almost no room", async () => {
    const summarize = vi.fn<Summarize>(async () => "сводка");
    const settings = { recentWindowSize: 4, threshold: 6_700 };
    // Over the threshold by a little; the one large result is the only thing a cap can cut, and
    // cutting it brings the history just under the threshold, where the next steps push it over again.
    const messages = [...exchange(0, 450), ...toolExchange(99, 3_200), ...Array.from({ length: 21 }, (_, index) => exchange(index + 1, 450)).flat(), CURRENT];
    expect(shouldCompact(messages, settings, UNMEASURED)).toBe(true);
    expect(estimateTokens(capToolResults(messages))).toBeLessThan(settings.threshold);

    const compacted = await compactMessages(messages, settings, summarize, UNMEASURED, 0);

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(compacted.slice(0, 2)).toEqual([
      { role: "user", content: "Summary of our conversation so far:" },
      { role: "assistant", content: "сводка" },
    ]);
  });

  it("replaces the older part with one checkpoint and keeps the recent tail verbatim", async () => {
    const summarize = vi.fn<Summarize>(async () => "Сделано: A. Осталось: B.");
    const messages = [...Array.from({ length: 20 }, (_, index) => exchange(index, 400)).flat(), CURRENT];

    const compacted = await compactMessages(messages, { recentWindowSize: 4, threshold: 2_000 }, summarize, UNMEASURED, 0);

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

    const compacted = await compactMessages(messages, { recentWindowSize: 4, threshold: 2_000 }, async () => "сводка", UNMEASURED, 0);

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

    await compactMessages(messages, { recentWindowSize: 2, threshold: 2_000 }, summarize, UNMEASURED, 0);

    expect(summarize.mock.calls[0]![0].prompt).toContain("<previous-checkpoint>\nстарая сводка\n</previous-checkpoint>");
  });

  it("summarizes a smaller part of the history each time the model refused the summary", async () => {
    const messages = [...Array.from({ length: 40 }, (_, index) => exchange(index, 2_000)).flat(), CURRENT];
    const promptTokens = async (refusals: number) => {
      const summarize = vi.fn<Summarize>(async () => "сводка");
      await compactMessages(messages, { recentWindowSize: 2, threshold: 40_000 }, summarize, UNMEASURED, refusals);
      return estimateTokens([{ content: summarize.mock.calls[0]![0].prompt, role: "user" }]);
    };

    // #331: a summary request the model refuses is refused again on the next message, the same
    // history and the same budget, forever. Each refusal halves what the next request carries.
    const first = await promptTokens(0);
    const second = await promptTokens(1);
    const third = await promptTokens(2);
    expect(second).toBeLessThan(first);
    expect(third).toBeLessThan(second);
  });

  // Production, 01.11.2026: a group's checkpoint had grown to 40 000 characters over 60 compactions;
  // rewritten with the newer part, the summary ran past the model's 16 384-token output limit twice,
  // and each cut summary failed a person's message.
  it("asks for a summary within a word limit, and for a shorter one after a refusal", async () => {
    const messages = [...Array.from({ length: 40 }, (_, index) => exchange(index, 2_000)).flat(), CURRENT];
    const promptOf = async (refusals: number) => {
      const summarize = vi.fn<Summarize>(async () => "сводка");
      await compactMessages(messages, { recentWindowSize: 2, threshold: 40_000 }, summarize, UNMEASURED, refusals);
      return summarize.mock.calls[0]![0].prompt;
    };

    expect(await promptOf(0)).toContain(`${COMPACTION_SUMMARY_WORD_LIMIT} words`);
    expect(await promptOf(1)).toContain(`${COMPACTION_BRIEF_SUMMARY_WORD_LIMIT} words`);
  });

  it("asks once more for a shorter summary in the same turn when the first ran past the output limit", async () => {
    const messages = [...Array.from({ length: 40 }, (_, index) => exchange(index, 2_000)).flat(), CURRENT];
    const truncated = new AppError("AGENT_MODEL_OUTPUT_TRUNCATED", "Модель оборвала ответ из-за ограничения длины");
    const summarize = vi.fn<Summarize>().mockRejectedValueOnce(truncated).mockResolvedValueOnce("сводка");

    const compacted = await compactMessages(messages, { recentWindowSize: 2, threshold: 40_000 }, summarize, UNMEASURED, 0);

    expect(summarize).toHaveBeenCalledTimes(2);
    expect(summarize.mock.calls[1]![0].prompt).toContain(`${COMPACTION_BRIEF_SUMMARY_WORD_LIMIT} words`);
    expect(compacted[1]).toEqual({ content: "сводка", role: "assistant" });

    // A second cut summary, or a refusal of another kind, is not asked again in the turn.
    const twice = vi.fn<Summarize>().mockRejectedValue(truncated);
    await expect(compactMessages(messages, { recentWindowSize: 2, threshold: 40_000 }, twice, UNMEASURED, 0)).rejects.toBe(truncated);
    expect(twice).toHaveBeenCalledTimes(2);
    const overflow = new AppError("AGENT_MODEL_CONTEXT_OVERFLOW", "Запрос не помещается в окно модели");
    const refused = vi.fn<Summarize>().mockRejectedValue(overflow);
    await expect(compactMessages(messages, { recentWindowSize: 2, threshold: 40_000 }, refused, UNMEASURED, 0)).rejects.toBe(overflow);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("drops the older part with a notice, without asking again, after the model refused it four times", async () => {
    const summarize = vi.fn<Summarize>(async () => "сводка");
    const messages = [...Array.from({ length: 20 }, (_, index) => exchange(index, 400)).flat(), CURRENT];

    const compacted = await compactMessages(messages, { recentWindowSize: 4, threshold: 2_000 }, summarize, UNMEASURED, 4);

    expect(summarize).not.toHaveBeenCalled();
    expect(compacted[0]).toEqual({ role: "user", content: "Summary of our conversation so far:" });
    expect(compacted[1]).toMatchObject({ role: "assistant", content: expect.stringContaining("could not be summarized") });
    expect(compacted.slice(2)).toEqual(messages.slice(-4));
    expect(shouldCompact(compacted, { recentWindowSize: 4, threshold: 2_000 }, UNMEASURED)).toBe(false);
  });

  it("keeps the summary it already had when it drops the part after it", async () => {
    const summarize = vi.fn<Summarize>(async () => "сводка");
    const messages = [
      { content: "Summary of our conversation so far:", role: "user" as const },
      { content: "старая сводка", role: "assistant" as const },
      ...Array.from({ length: 20 }, (_, index) => exchange(index, 400)).flat(),
      CURRENT,
    ];

    const compacted = await compactMessages(messages, { recentWindowSize: 4, threshold: 2_000 }, summarize, UNMEASURED, 4);

    // The earlier summary fit and was accepted; only what came after it is lost to the refusals,
    // and the notice says so instead of disowning the summary above it.
    expect(compacted[1]).toMatchObject({
      role: "assistant", content: expect.stringMatching(/^старая сводка\n\n.*between the summary above and the messages that follow/su),
    });
    expect(compacted.slice(2)).toEqual(messages.slice(-4));
  });

  it("drops the earlier summary too when keeping it would leave no room for the recent messages", async () => {
    const summarize = vi.fn<Summarize>(async () => "сводка");
    const messages = [
      { content: "Summary of our conversation so far:", role: "user" as const },
      { content: `старая сводка ${"с".repeat(20_000)}`, role: "assistant" as const },
      ...Array.from({ length: 20 }, (_, index) => exchange(index, 400)).flat(),
      CURRENT,
    ];

    const compacted = await compactMessages(messages, { recentWindowSize: 4, threshold: 2_000 }, summarize, UNMEASURED, 4);

    // The way out after four refusals must not end in a history too large to send, every message.
    expect(compacted[1]).toMatchObject({ role: "assistant", content: expect.stringMatching(/^The earlier part of this conversation could not be summarized/u) });
    expect(compacted.slice(2)).toEqual(messages.slice(-4));
    expect(shouldCompact(compacted, { recentWindowSize: 4, threshold: 2_000 }, UNMEASURED)).toBe(false);
  });

  it("fails with a coded error instead of a second summary call when the result does not fit", async () => {
    const summarize = vi.fn<Summarize>(async () => "s".repeat(40_000));
    const messages = Array.from({ length: 8 }, (_, index) => exchange(index, 2_000)).flat();

    await expect(compactMessages(messages, { recentWindowSize: 4, threshold: 6_000 }, summarize, UNMEASURED, 0))
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
