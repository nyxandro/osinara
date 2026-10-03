import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import { compactionSettings, compactMessages, shouldCompact, todoCompactionMessage, type Summarize } from "./compaction.js";

const NO_COUNTERS = { inputTokens: null, promptMessageCount: null };
// Compaction runs before a model call, so the prompt ends with the person's message.
const CURRENT: ModelMessage = { role: "user", content: "текущий вопрос" };

function exchange(index: number, size = 50): ModelMessage[] {
  return [
    { role: "user", content: `вопрос ${index} ${"x".repeat(size)}` },
    { role: "assistant", content: [{ type: "text", text: `ответ ${index} ${"y".repeat(size)}` }] },
  ];
}

function toolExchange(index: number, resultSize: number): ModelMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: `c${index}`, toolName: "bash", input: { command: "cat" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: `c${index}`, toolName: "bash", output: { type: "text", value: "z".repeat(resultSize) } }] },
  ];
}

describe("history compaction", () => {
  it("compacts once the provider-reported prompt plus what came after passes the threshold", () => {
    const settings = compactionSettings(10_000, 0.75);
    const messages = exchange(1);

    expect(settings).toEqual({ recentWindowSize: 10, threshold: 7_500 });
    expect(shouldCompact(messages, settings, NO_COUNTERS)).toBe(false);
    expect(shouldCompact(messages, settings, { inputTokens: 7_400, promptMessageCount: 1 })).toBe(true);
    expect(shouldCompact(messages, settings, { inputTokens: 7_400, promptMessageCount: 5 })).toBe(false);
  });

  it("caps old tool results without a summary call when that is enough", async () => {
    const summarize = vi.fn<Summarize>(async () => "сводка");
    const messages = [...exchange(0), ...toolExchange(1, 20_000), ...exchange(2), ...exchange(3), ...exchange(4), ...exchange(5), ...exchange(6), CURRENT];

    const compacted = await compactMessages(messages, { recentWindowSize: 10, threshold: 2_400 }, summarize);

    expect(summarize).not.toHaveBeenCalled();
    expect(compacted[3]).toMatchObject({ role: "tool", content: [{ output: { type: "text", value: expect.stringMatching(/^\[Truncated: /) } }] });
    expect(compacted.slice(-10)).toEqual(messages.slice(-10));
    expect(compacted).toHaveLength(messages.length);
  });

  it("replaces the older part with one checkpoint and keeps the recent tail verbatim", async () => {
    const summarize = vi.fn<Summarize>(async () => "Сделано: A. Осталось: B.");
    const messages = [...Array.from({ length: 20 }, (_, index) => exchange(index, 400)).flat(), CURRENT];

    const compacted = await compactMessages(messages, { recentWindowSize: 4, threshold: 2_000 }, summarize);

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

    const compacted = await compactMessages(messages, { recentWindowSize: 4, threshold: 2_000 }, async () => "сводка");

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

    await compactMessages(messages, { recentWindowSize: 2, threshold: 2_000 }, summarize);

    expect(summarize.mock.calls[0]![0].prompt).toContain("<previous-checkpoint>\nстарая сводка\n</previous-checkpoint>");
  });

  it("fails with a coded error instead of a second summary call when the result does not fit", async () => {
    const summarize = vi.fn<Summarize>(async () => "s".repeat(40_000));
    const messages = Array.from({ length: 8 }, (_, index) => exchange(index, 2_000)).flat();

    await expect(compactMessages(messages, { recentWindowSize: 4, threshold: 6_000 }, summarize))
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
