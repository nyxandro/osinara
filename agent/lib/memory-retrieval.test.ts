/**
 * Turn-level memory retrieval tests.
 *
 * Constructs covered:
 * - The newest user text is extracted from plain and multipart Eve model messages.
 */
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { latestUserText } from "./memory-retrieval.js";

describe("latestUserText", () => {
  it("returns the newest plain user message", () => {
    const messages = [
      { content: "старый вопрос", role: "user" },
      { content: "ответ", role: "assistant" },
      { content: "новый вопрос", role: "user" },
    ] as ModelMessage[];

    expect(latestUserText(messages)).toBe("новый вопрос");
  });

  it("joins only text parts from multipart user content", () => {
    const messages = [
      {
        content: [
          { text: "Что мне", type: "text" },
          { data: "data:image/png;base64,AA==", mediaType: "image/png", type: "file" },
          { text: "нельзя есть?", type: "text" },
        ],
        role: "user",
      },
    ] as ModelMessage[];

    expect(latestUserText(messages)).toBe("Что мне\nнельзя есть?");
  });
});
