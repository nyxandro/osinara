/**
 * Telegram's own rich tags the answer may carry: a moment in the reader's time zone, a map, a collage
 * and a slideshow.
 *
 * Constructs covered:
 * - Each allowed tag is read in the spellings a model writes and rewritten to the one form Telegram
 *   receives; a moment written with its offset becomes Telegram's Unix time.
 * - Anything Telegram would refuse (a moment without an offset, a format it does not know, a point
 *   off the globe, a zoom past 24) or the model must not write (its own Unix time, an attribute of
 *   its own) is not a tag at all.
 * - The answer check names every such tag and an empty or unclosed one, outside code only.
 * - The containers stand on lines of their own, so the files inside them read as files.
 */
import { describe, expect, it } from "vitest";

import {
  canonicalTelegramRichTag,
  isSelfClosingTelegramRichTag,
  separateTelegramRichContainers,
  telegramRichTagsNotice,
} from "./telegram-rich-tags.js";

// 7 November 2026, 19:00 in Moscow (UTC+3) is 16:00 UTC.
const SATURDAY_EVENING_UNIX = "1794067200";

describe("canonicalTelegramRichTag", () => {
  it.each([
    ["<tg-collage>", "<tg-collage>"],
    ["<TG-Collage >", "<tg-collage>"],
    ["</tg-collage>", "</tg-collage>"],
    ["<tg-slideshow>", "<tg-slideshow>"],
    ["</tg-slideshow >", "</tg-slideshow>"],
    ["<tg-map lat=\"55.7558\" long=\"37.6173\" zoom=\"15\"/>", "<tg-map lat=\"55.7558\" long=\"37.6173\" zoom=\"15\"/>"],
    ["<tg-map long='37.6' lat='-55.7'>", "<tg-map lat=\"-55.7\" long=\"37.6\"/>"],
    ["<tg-map lat=\"90\" long=\"-180\" zoom=\"0\" />", "<tg-map lat=\"90\" long=\"-180\" zoom=\"0\"/>"],
    ["<tg-time at=\"2026-11-07T19:00:00+03:00\" format=\"wt\">", `<tg-time unix="${SATURDAY_EVENING_UNIX}" format="wt">`],
    ["<tg-time format=\"Dt\" at=\"2026-11-07T19:00+03:00\">", `<tg-time unix="${SATURDAY_EVENING_UNIX}" format="Dt">`],
    ["<tg-time at=\"2026-11-07T16:00:00Z\" format=\"r\">", `<tg-time unix="${SATURDAY_EVENING_UNIX}" format="r">`],
    ["<tg-time at=\"2026-11-07T19:00:00+03:00\" format=\"\">", `<tg-time unix="${SATURDAY_EVENING_UNIX}" format="">`],
    ["</tg-time>", "</tg-time>"],
  ])("reads %s as %s", (tag, canonical) => {
    expect(canonicalTelegramRichTag(tag)).toBe(canonical);
  });

  it.each([
    ["a collage with an attribute", "<tg-collage style=\"x\">"],
    ["a space before the name", "< tg-collage>"],
    ["a point past the pole", "<tg-map lat=\"91\" long=\"37\"/>"],
    ["a point past the date line", "<tg-map lat=\"55\" long=\"181\"/>"],
    ["a zoom past 24", "<tg-map lat=\"55\" long=\"37\" zoom=\"25\"/>"],
    ["a fractional zoom", "<tg-map lat=\"55\" long=\"37\" zoom=\"1.5\"/>"],
    ["a map without a longitude", "<tg-map lat=\"55\"/>"],
    ["a word for a latitude", "<tg-map lat=\"north\" long=\"37\"/>"],
    ["a map with a size", "<tg-map lat=\"55\" long=\"37\" width=\"100\"/>"],
    ["a closing map tag", "</tg-map>"],
    ["a moment without an offset", "<tg-time at=\"2026-11-07T19:00\" format=\"wt\">"],
    ["a date that does not exist", "<tg-time at=\"2026-02-30T19:00:00+03:00\" format=\"wt\">"],
    ["a moment without a format", "<tg-time at=\"2026-11-07T19:00:00+03:00\">"],
    ["a relative format with others", "<tg-time at=\"2026-11-07T19:00:00+03:00\" format=\"rw\">"],
    ["an unknown format letter", "<tg-time at=\"2026-11-07T19:00:00+03:00\" format=\"wx\">"],
    ["the model's own Unix time", `<tg-time unix="${SATURDAY_EVENING_UNIX}" format="wt">`],
    ["a button", "<tg-button>"],
    ["a thinking block", "<tg-thinking>"],
  ])("refuses %s", (_case, tag) => {
    expect(canonicalTelegramRichTag(tag)).toBeNull();
  });

  it("tells a self-closing map from the containers and the moment", () => {
    expect(isSelfClosingTelegramRichTag("<tg-map lat=\"55\" long=\"37\"/>")).toBe(true);
    expect(isSelfClosingTelegramRichTag("<tg-collage>")).toBe(false);
    expect(isSelfClosingTelegramRichTag(`<tg-time unix="${SATURDAY_EVENING_UNIX}" format="wt">`)).toBe(false);
  });
});

describe("telegramRichTagsNotice", () => {
  it("passes an answer whose tags are all valid", () => {
    expect(telegramRichTagsNotice([
      "Созвон <tg-time at=\"2026-11-07T19:00:00+03:00\" format=\"wt\">суббота, 19:00</tg-time>.",
      "",
      "<tg-map lat=\"55.7558\" long=\"37.6173\" zoom=\"15\"/>",
      "",
      "<tg-collage>",
      "",
      "![](/workspace/family/a.jpg)",
      "",
      "</tg-collage>",
    ].join("\n"))).toBeUndefined();
    expect(telegramRichTagsNotice("Без тегов.")).toBeUndefined();
  });

  it("names each wrong tag, an empty moment and an unclosed container", () => {
    const notice = telegramRichTagsNotice([
      "Созвон <tg-time at=\"2026-11-07T19:00\" format=\"wt\">суббота</tg-time>.",
      "Срок <tg-time at=\"2026-11-07T19:00:00+03:00\" format=\"wt\"></tg-time>.",
      "<tg-map lat=\"200\" long=\"37\"/>",
      "<tg-slideshow>",
    ].join("\n"));

    expect(notice).toContain("<tg-time at=\"2026-11-07T19:00\" format=\"wt\">");
    expect(notice).toContain("with its offset");
    expect(notice).toContain("text inside <tg-time>");
    expect(notice).toContain("<tg-map lat=\"200\" long=\"37\"/>");
    expect(notice).toContain("<tg-slideshow> is not closed");
    expect(notice?.startsWith("Your answer was not delivered")).toBe(true);
  });

  it("ignores tags shown as code", () => {
    expect(telegramRichTagsNotice("Пример: `<tg-time at=\"2026\">x</tg-time>`\n\n```\n<tg-map lat=\"999\"/>\n```")).toBeUndefined();
  });
});

describe("separateTelegramRichContainers", () => {
  it("puts the container tags on lines of their own, so the files inside read as files", () => {
    expect(separateTelegramRichContainers(
      "Фото с дачи:\n<tg-collage>\n![](/workspace/family/a.jpg)\n![](/workspace/family/b.jpg)\n</tg-collage>\nВсё.",
    )).toBe(
      "Фото с дачи:\n\n<tg-collage>\n\n![](/workspace/family/a.jpg)\n![](/workspace/family/b.jpg)\n\n</tg-collage>\n\nВсё.",
    );
  });

  it("leaves a well separated answer and code exactly as written", () => {
    const separated = "<tg-slideshow>\n\n![](/workspace/family/a.jpg)\n\n</tg-slideshow>";
    expect(separateTelegramRichContainers(separated)).toBe(separated);
    const code = "```\n<tg-collage>\n![](/workspace/a.jpg)\n</tg-collage>\n```";
    expect(separateTelegramRichContainers(code)).toBe(code);
  });
});
