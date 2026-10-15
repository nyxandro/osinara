/**
 * Regression tests for the model-facing `remember` input contract.
 *
 * Covers:
 * - strict normalization of a JSON-serialized `subject` emitted by a model provider;
 * - normalization through the same AI SDK schema adapter used for tool calls;
 * - rejection of malformed or structurally invalid serialized subjects.
 */
import { zodSchema } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { externalRememberInputSchema } from "./remember-contract.js";

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
