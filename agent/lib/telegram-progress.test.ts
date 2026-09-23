/**
 * Telegram model-message delivery policy tests.
 *
 * Constructs covered:
 * - `completedTelegramOutput`: separates visible text from terminal reaction directives.
 * - Pre-tool assistant chunks remain hidden because Telegram cannot render them ephemerally.
 * - Empty model steps remain invisible to avoid technical Telegram noise.
 * - Eve's `message: null` after a final step is the model's deliberate silence, not noise.
 * - The model may mark a final answer as a standalone message instead of a reply.
 * - `telegramOutputWithoutMemoryDirective`: the memory-usage line leaves on every branch.
 */
import { describe, expect, it } from "vitest";

import {
  completedTelegramOutput,
  telegramOutputWithoutMemoryDirective,
} from "./telegram-progress.js";

describe("completedTelegramOutput", () => {
  it("delivers model-authored pre-tool text as an interim progress notice", () => {
    expect(
      completedTelegramOutput({
        finishReason: "tool-calls",
        message: "Собрал информацию. Теперь формирую документ.",
      }),
    ).toEqual({ kind: "progress", message: "Собрал информацию. Теперь формирую документ." });
  });

  it("drops interim text that carries the silence marker instead of announcing it", () => {
    expect(
      completedTelegramOutput({
        finishReason: "tool-calls",
        message: "Молчу <eve-empty-delivery/>",
      }),
    ).toBeNull();
  });

  it("drops interim text that carries a reaction directive", () => {
    expect(
      completedTelegramOutput({
        finishReason: "tool-calls",
        message: "<telegram-reaction>👍</telegram-reaction>",
      }),
    ).toBeNull();
  });

  it("does not deliver an answer made of transport directives alone", () => {
    expect(completedTelegramOutput({ finishReason: "stop", message: "[[split]]" }))
      .toBeNull();
  });

  it("keeps aside directives inside a final answer for the presentation layer", () => {
    expect(
      completedTelegramOutput({ finishReason: "stop", message: "Готово\n[[split]]\nкстати" }),
    ).toEqual({ kind: "message", message: "Готово\n[[split]]\nкстати", standalone: false });
  });

  it("trims surrounding whitespace from a delivered message", () => {
    expect(
      completedTelegramOutput({ finishReason: "stop", message: "\n\nГотовый ответ  " }),
    ).toEqual({ kind: "message", message: "Готовый ответ", standalone: false });
  });

  it.each(["👍", "❤", "❤️", "🔥", "🥰", "🤔", "🤯", "🫡", "👀", "🖕", "1️⃣", "🇺🇸"])(
    "parses one %s emoji reaction without visible text",
    (emoji) => {
      expect(
        completedTelegramOutput({
          finishReason: "stop",
          message: `\n<telegram-reaction>${emoji}</telegram-reaction>\n`,
        }),
      ).toEqual({ emoji, kind: "reaction" });
    },
  );

  it.each([
    "<telegram-reaction>не emoji</telegram-reaction>",
    "<telegram-reaction>🔥🔥</telegram-reaction>",
    "<telegram-reaction>🇦</telegram-reaction>",
    "Хорошо <telegram-reaction>👌</telegram-reaction>",
    "<telegram-reaction>👍</telegram-reaction> Молчу",
    "<telegram-reaction></telegram-reaction>",
  ])("rejects malformed or mixed reaction output: %s", (message) => {
    expect(() => completedTelegramOutput({ finishReason: "stop", message }))
      .toThrowError(/AGENT_TELEGRAM_REACTION_DIRECTIVE_INVALID/u);
  });

  it.each([
    { finishReason: "tool-calls", message: "   " },
    { finishReason: "tool-calls", message: null },
    { finishReason: "stop", message: "" },
    { finishReason: "stop" },
  ])("does not expose an empty technical step %#", (data) => {
    expect(completedTelegramOutput(data)).toBeNull();
  });

  it("delivers an answer marked by the model as a standalone message without the directive", () => {
    expect(
      completedTelegramOutput({ finishReason: "stop", message: "[[no-reply]]\nСоседи, домофон снова сломан." }),
    ).toEqual({ kind: "message", message: "Соседи, домофон снова сломан.", standalone: true });
  });

  it("does not deliver an answer made of the standalone directive alone", () => {
    expect(completedTelegramOutput({ finishReason: "stop", message: "[[no-reply]]" })).toBeNull();
  });

  it("still recognizes a reaction written next to the standalone directive", () => {
    expect(
      completedTelegramOutput({
        finishReason: "stop",
        message: "[[no-reply]]\n<telegram-reaction>👍</telegram-reaction>",
      }),
    ).toEqual({ emoji: "👍", kind: "reaction" });
  });

  it("keeps the standalone directive out of an interim progress notice", () => {
    expect(
      completedTelegramOutput({ finishReason: "tool-calls", message: "[[no-reply]]\nСекунду, ищу." }),
    ).toEqual({ kind: "progress", message: "Секунду, ищу." });
  });

  it("recognizes Eve's undelivered final step as the model's deliberate silence", () => {
    expect(completedTelegramOutput({ finishReason: "stop", message: null })).toEqual({ kind: "silence" });
  });
});

const REF = "mem_0123456789abcdef0123456789abcdef";

describe("telegramOutputWithoutMemoryDirective", () => {
  it("keeps the line out of the interim progress notice", () => {
    const { declaration, output } = telegramOutputWithoutMemoryDirective({
      finishReason: "tool-calls",
      message: `Секунду, смотрю календарь.\n[память: ${REF}]`,
    });

    expect(output).toEqual({ kind: "progress", message: "Секунду, смотрю календарь." });
    expect(declaration.memoryRefs).toEqual([REF]);
  });

  it("still recognizes a reaction when the line was appended to it", () => {
    // The reaction directive has to be the whole message; the memory line would otherwise turn a
    // silent reaction into AGENT_TELEGRAM_REACTION_DIRECTIVE_INVALID.
    const { declaration, output } = telegramOutputWithoutMemoryDirective({
      finishReason: "stop",
      message: `<telegram-reaction>👍</telegram-reaction>\n[память: ${REF}]`,
    });

    expect(output).toEqual({ emoji: "👍", kind: "reaction" });
    expect(declaration.memoryRefs).toEqual([REF]);
  });

  it("keeps the line out of the answer a person reads", () => {
    const { output } = telegramOutputWithoutMemoryDirective({
      finishReason: "stop",
      message: `Код домофона 4271.\n\n[память: ${REF}]`,
    });

    expect(output).toEqual({ kind: "message", message: "Код домофона 4271.", standalone: false });
  });

  it("delivers nothing when the answer was the line and nothing else", () => {
    expect(telegramOutputWithoutMemoryDirective({
      finishReason: "stop",
      message: `[память: ${REF}]`,
    }).output).toBeNull();
  });

  it("leaves deliberate silence exactly as it was", () => {
    expect(telegramOutputWithoutMemoryDirective({ finishReason: "stop", message: null }))
      .toEqual({
        declaration: { answer: "", declared: false, memoryRefs: [] },
        output: { kind: "silence" },
      });
  });
});
