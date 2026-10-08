/**
 * Pointing «ты» at the assistant in a group's memory search.
 *
 * Constructs covered:
 * - A question about the assistant gets its name back after the address was cut.
 * - A quoted «ты», a question without «ты» and a question that names the assistant stay as they are.
 */
import { describe, expect, it } from "vitest";

import { prepareMemoryQuery } from "./memory-query-preparation.js";
import { withAssistantName } from "./memory-persona-query.js";

const searched = (message: string) => withAssistantName(prepareMemoryQuery(message));

describe("withAssistantName", () => {
  it.each([
    ["Осинара, как ты выглядишь?", "как ты выглядишь? Осинара"],
    ["кто тебя сделал?", "кто тебя сделал? Осинара"],
    ["откуда у тебя такой голос?", "откуда у тебя такой голос? Осинара"],
    ["Осинара, напомни твой гитхаб", "напомни твой гитхаб Осинара"],
  ])("names the assistant in «%s»", (message, expected) => {
    expect(searched(message)).toBe(expected);
  });

  it.each([
    "он сказал: ты неправ",
    "где живёт Роман?",
    "тебе нравится имя Осинара?",
    "Осинара умеет читать PDF?",
  ])("leaves «%s» as it is", (message) => {
    expect(searched(message)).toBe(prepareMemoryQuery(message));
  });
});
