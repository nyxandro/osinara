/**
 * A text label that only names the author of the record's own source message.
 *
 * Constructs covered:
 * - `labelNamesSourceAuthor`: the author's display name, username, @username and
 *   "display (username)" are the author, whatever the case and spacing; a label naming someone
 *   else, a nickname the message does not carry, or the author plus a topic is not; a bare name
 *   another participant of the chat also carries is not either.
 * - `bindSourceAuthorLabel`: such a label becomes the verified author; every other subject stays.
 *
 * From 27.09 to 17.10.2026 the silent review wrote 274 facts about the author of the chosen message
 * under a hand-written name instead of `current_author`, so none of them reached that person's
 * profile and the duplicate check never compared them with the person's verified records.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { bindSourceAuthorLabel, labelNamesSourceAuthor } from "./memory-subject-author-label.js";

const PUH = { displayNames: ["Пух"], displayNameShared: false, username: "nyxandro" };

describe("labelNamesSourceAuthor", () => {
  it.each([
    "Пух (nyxandro)",
    "Пух (@nyxandro)",
    "пух  (NYXANDRO)",
    " Пух ",
    "nyxandro",
    "@nyxandro",
  ])("takes %j for the author", (label) => {
    expect(labelNamesSourceAuthor(label, PUH)).toBe(true);
  });

  it.each([
    // A nickname the message does not carry: the username alone would decide, and it is not checked.
    "Sania (nyxandro)",
    // The author plus a topic is a topic, not the person.
    "Пух (nyxandro) — Mastra",
    "Проект Пуха (nyxandro)",
    // Someone else named in the author's message.
    "Алексей (alex_ive)",
    "Пух (alex_ive)",
    "Пух nyxandro",
  ])("leaves %j as a text label", (label) => {
    expect(labelNamesSourceAuthor(label, PUH)).toBe(false);
  });

  it("matches any display name the author carries: on the message and on the participant", () => {
    const author = { displayNames: ["✨ Юни", "Юни"], displayNameShared: false, username: "goduni" };

    expect(labelNamesSourceAuthor("Юни (goduni)", author)).toBe(true);
    expect(labelNamesSourceAuthor("✨ Юни", author)).toBe(true);
  });

  it("needs the username to accept a label that carries one", () => {
    const author = { displayNames: ["Brain4Qs"], displayNameShared: false, username: null };

    expect(labelNamesSourceAuthor("Brain4Qs", author)).toBe(true);
    expect(labelNamesSourceAuthor("Brain4Qs (brain4Qs)", author)).toBe(false);
  });

  it("ignores an empty display name rather than matching an empty label", () => {
    expect(labelNamesSourceAuthor(" ", { displayNames: [" "], displayNameShared: false, username: null }))
      .toBe(false);
  });

  it("does not take a bare name another participant of the chat also carries", () => {
    // Two «Alexey» in one chat: the name alone does not say which one the fact is about.
    const author = { displayNames: ["Alexey"], displayNameShared: true, username: "Dj_Frakov" };

    expect(labelNamesSourceAuthor("Alexey", author)).toBe(false);
    expect(labelNamesSourceAuthor("Alexey (Dj_Frakov)", author)).toBe(true);
    expect(labelNamesSourceAuthor("@dj_frakov", author)).toBe(true);
  });

  it("binds every spelling of the author and nothing that names someone else", () => {
    const word = fc.stringMatching(/^[A-Za-zА-Яа-яЁё0-9✨]{1,8}$/u);
    const display = fc.array(word, { maxLength: 3, minLength: 1 }).map((words) => words.join(" "));
    const username = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{4,31}$/u);
    // What a model or Telegram does to a name without changing whose it is.
    const respell = (value: string, upper: boolean, gap: string) =>
      `${gap}${(upper ? value.toUpperCase() : value.toLowerCase()).replaceAll(" ", gap || " ")}${gap}`;
    const gap = fc.constantFrom("", " ", "  ", "\t", " ");

    fc.assert(fc.property(display, username, username, fc.boolean(), gap, (name, own, other, upper, space) => {
      // A second person needs a name of their own: the rare draw where it equals the first is skipped.
      fc.pre(other.toLowerCase() !== own.toLowerCase() && other.toLowerCase() !== name.toLowerCase());
      const author = { displayNames: [name], displayNameShared: false, username: own };
      for (const label of [name, own, `@${own}`, `${name} (${own})`, `${name} (@${own})`]) {
        expect(labelNamesSourceAuthor(respell(label, upper, space), author)).toBe(true);
      }
      for (const label of [other, `@${other}`, `${name} (${other})`, `${name} (${own}) — ${other}`]) {
        expect(labelNamesSourceAuthor(label, author)).toBe(false);
      }
    }), {
      examples: [
        // Production: the review wrote the author of #44509 as this label.
        ["Пух", "nyxandro", "alex_ive", false, ""],
        ["serge shima", "shimaoz", "aostrikov", true, "  "],
      ],
    });
  });
});

describe("bindSourceAuthorLabel", () => {
  it("turns a label naming the author into the verified author", () => {
    expect(bindSourceAuthorLabel({ kind: "label", label: "Пух (nyxandro)" }, PUH))
      .toEqual({ kind: "current_author" });
  });

  it("leaves every other subject exactly as the model sent it", () => {
    const other = { kind: "label", label: "Алексей (alex_ive)" } as const;
    const none = { kind: "none" } as const;

    expect(bindSourceAuthorLabel(other, PUH)).toBe(other);
    expect(bindSourceAuthorLabel(none, PUH)).toBe(none);
  });
});
