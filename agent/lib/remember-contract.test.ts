/**
 * Regression tests for the model-facing `remember` input contract.
 *
 * Covers:
 * - strict normalization of a JSON-serialized `subject` emitted by a model provider;
 * - normalization through the same AI SDK schema adapter used for tool calls;
 * - rejection of malformed or structurally invalid serialized subjects.
 * - `replaces` only together with `attribute`: it names the current version of that property.
 * - a discussion summary («итог: <тема>») is a fact about no person, kept outside threads.
 */
import { zodSchema } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createReviewRememberInputSchema,
  externalRememberInputSchema,
} from "./remember-contract.js";

const BASE_EXTERNAL_INPUT = {
  basis: "agent_inferred",
  content: "Пользователь завершил обсуждавшийся эпизод.",
  kind: "episode",
  scope: "group",
  sensitivity: "normal",
} as const;

describe("externalRememberInputSchema", () => {
  it("fills the group's only scope when the model leaves it out", async () => {
    // 9 of 12 rejected remember calls in production (03-15.10.2026) omitted this one-value field.
    const { scope: _scope, ...withoutScope } = BASE_EXTERNAL_INPUT;
    const result = await zodSchema(externalRememberInputSchema).validate!({
      ...withoutScope,
      subject: { kind: "current_author" },
    });

    expect(result).toMatchObject({ success: true, value: { scope: "group" } });
    expect(externalRememberInputSchema.safeParse({ ...BASE_EXTERNAL_INPUT, scope: "personal", subject: { kind: "none" } }).success)
      .toBe(false);
    const required = (z.toJSONSchema(externalRememberInputSchema, { io: "input" }) as { required?: string[] }).required;
    expect(required).not.toContain("scope");
  });

  it("accepts the exact production payload through the AI SDK validator", async () => {
    const schema = zodSchema(externalRememberInputSchema);
    const result = await schema.validate!({
      ...BASE_EXTERNAL_INPUT,
      subject: '{"kind":"current_author"}',
    });

    expect(result).toMatchObject({
      success: true,
      value: { subject: { kind: "current_author" } },
    });
  });

  it.each([
    ['{"kind":"current_author"}', { kind: "current_author" }],
    [' { "kind" : "none" } ', { kind: "none" }],
    [
      '{"kind":"verified_ref","subjectRef":"subj_0123456789abcdef0123456789abcdef"}',
      { kind: "verified_ref", subjectRef: "subj_0123456789abcdef0123456789abcdef" },
    ],
    ['{"label":"Проект \\"Осинара\\"","kind":"label"}', { kind: "label", label: 'Проект "Осинара"' }],
  ])("normalizes a provider-serialized subject: %s", (subject, expected) => {
    const result = externalRememberInputSchema.safeParse({
      ...BASE_EXTERNAL_INPUT,
      subject,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subject).toEqual(expected);
    }
  });

  it.each([
    ["malformed JSON", '{"kind":'],
    ["invalid subject shape", '{"kind":"current_author","subjectRef":"subj_0123456789abcdef0123456789abcdef"}'],
  ])("rejects %s instead of weakening subject validation", (_caseName, subject) => {
    expect(externalRememberInputSchema.safeParse({
      ...BASE_EXTERNAL_INPUT,
      subject,
    }).success).toBe(false);
  });
});

describe("replaces", () => {
  const FACT = {
    basis: "agent_inferred",
    content: "Пух (nyxandro) работает в 7RL",
    kind: "profile",
    sensitivity: "normal",
    subject: { kind: "current_author" },
  } as const;
  const CURRENT = "mem_0123456789abcdef0123456789abcdef";

  it("is taken together with the property it names a version of", () => {
    expect(externalRememberInputSchema.safeParse({ ...FACT, attribute: "место работы", replaces: [CURRENT] }).success)
      .toBe(true);
    expect(createReviewRememberInputSchema("group").safeParse({
      ...FACT, attribute: "место работы", replaces: [CURRENT], sourceSequence: "42",
    }).success).toBe(true);
  });

  it("is refused without a property: only the current version of a property can be replaced", () => {
    const result = externalRememberInputSchema.safeParse({ ...FACT, replaces: [CURRENT] });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("AGENT_MEMORY_ATTRIBUTE_INVALID");
  });

  it("accepts only opaque memory refs", () => {
    expect(externalRememberInputSchema.safeParse({ ...FACT, attribute: "место работы", replaces: ["7RL"] }).success)
      .toBe(false);
  });
});

describe("discussion summary", () => {
  const SUMMARY = {
    attribute: "Итог: платный канал по эвалам",
    basis: "agent_inferred",
    content: "Обсуждали платный канал по эвалам: план готов, автор ещё не согласился, открыт вопрос налогов.",
    kind: "fact",
    sensitivity: "normal",
    sourceSequence: "47961",
    subject: { kind: "none" },
  } as const;

  function refusal(input: Record<string, unknown>): string {
    const result = createReviewRememberInputSchema("group").safeParse(input);
    expect(result.success).toBe(false);
    return JSON.stringify(result.error?.issues);
  }

  it("is a fact about no person, saved by its topic", () => {
    expect(createReviewRememberInputSchema("group").safeParse(SUMMARY).success).toBe(true);
    expect(createReviewRememberInputSchema("group").safeParse({
      ...SUMMARY, replaces: ["mem_0123456789abcdef0123456789abcdef"],
    }).success).toBe(true);
  });

  it("is refused about a person, as an event or inside a thread, saying why", () => {
    // Every version must hold the same slot: the topic for the whole conversation, outside a project.
    expect(refusal({ ...SUMMARY, subject: { kind: "current_author" } })).toContain("AGENT_MEMORY_ATTRIBUTE_INVALID");
    expect(refusal({ ...SUMMARY, subject: { kind: "label", label: "Эвалы" } })).toContain("subject.kind=none");
    expect(refusal({ ...SUMMARY, kind: "preference" })).toContain("kind=fact");
    expect(refusal({ ...SUMMARY, kind: "episode" })).toContain("kind=fact");
    expect(refusal({
      ...SUMMARY,
      thread: { action: "create", identity: "project", purpose: "Платный канал", role: "decision", title: "Эвалы" },
    })).toContain("без нити");
    expect(refusal({ ...SUMMARY, attribute: "итог:" })).toContain("тему");
    // Without the colon it would be one slot for the whole conversation, and the next topic would
    // be told to replace the summary of another one.
    expect(refusal({ ...SUMMARY, attribute: "итог обсуждения" })).toContain("итог: <тема>");
    expect(refusal({ ...SUMMARY, attribute: "Итоги" })).toContain("итог: <тема>");
    expect(createReviewRememberInputSchema("group").safeParse({ ...SUMMARY, attribute: "итоговая оценка", kind: "fact" }).success)
      .toBe(true);
  });

  it("names the field when the message number is written with a sign", () => {
    // The field description says «#sequence», and BigInt("#47961") used to throw out of the schema.
    const result = createReviewRememberInputSchema("group").safeParse({ ...SUMMARY, sourceSequence: "#47961" });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: "invalid_format", path: ["sourceSequence"] });
  });
});
