import { InvalidToolInputError, JSONParseError, NoSuchToolError, TypeValidationError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { logRejectedToolCall, rejectedToolCall } from "./tool-input-errors.js";

// The error AI SDK 7.0.60 attaches to a call whose input failed the tool's schema.
function invalidInput(schema: z.ZodType, input: Record<string, unknown>): InvalidToolInputError {
  const parsed = schema.safeParse(input);
  if (parsed.success) throw new Error("TEST_INPUT_IS_VALID");
  return new InvalidToolInputError({
    cause: new TypeValidationError({ cause: parsed.error, value: input }),
    toolInput: JSON.stringify(input),
    toolName: "probe",
  });
}

function contractOf(output: { type: string; value?: unknown }) {
  expect(output.type).toBe("error-text");
  const text = String(output.value);
  expect(text.startsWith("ModelFacingError: ")).toBe(true);
  return JSON.parse(text.slice(text.indexOf("{"))) as Record<string, unknown>;
}

const REMEMBER_LIKE = z.object({
  kind: z.enum(["fact", "episode"]),
  scope: z.literal("group").default("group"),
  subject: z.object({ kind: z.string() }),
}).strict();

afterEach(() => vi.restoreAllMocks());

describe("a tool call refused before it ran", () => {
  it("answers in the common error format, in Russian, field by field, and keeps what the model sent", () => {
    const input = { extra: 1, kind: "note", scope: "personal", subject: { kind: 3 } };

    const rejected = rejectedToolCall({ error: invalidInput(REMEMBER_LIKE, input), input, toolName: "remember" });

    const contract = contractOf(rejected.output);
    expect(contract).toMatchObject({
      category: "input",
      code: "AGENT_TOOL_INPUT_INVALID",
      field: "kind",
      retryable: true,
      sideEffectStatus: "not_started",
    });
    expect(contract.reason).toContain("kind: Неверный вариант: ожидалось одно из \"fact\"|\"episode\"");
    expect(contract.reason).toContain("scope: Неверный ввод: ожидалось \"group\"");
    expect(contract.reason).toContain("subject.kind: Неверный ввод: ожидалось string, получено число");
    expect(contract.reason).toContain("Нераспознанный ключ: \"extra\"");
    expect(contract.reason).not.toMatch(/Invalid input|expected/u);
    expect(String(contract.correction)).toContain("remember");
    expect(rejected.input).toEqual(input);
    expect(rejected.metrics).toEqual({
      errorCode: "AGENT_TOOL_INPUT_INVALID",
      issues: [
        { code: "invalid_value", field: "kind" },
        { code: "invalid_value", field: "scope" },
        { code: "invalid_type", field: "subject.kind" },
        { code: "unrecognized_keys", field: "extra" },
      ],
      issueCount: 4,
    });
  });

  it("names a missing required field", () => {
    const rejected = rejectedToolCall({ error: invalidInput(REMEMBER_LIKE, { kind: "fact" }), input: { kind: "fact" }, toolName: "remember" });

    expect(contractOf(rejected.output)).toMatchObject({ field: "subject" });
    expect(contractOf(rejected.output).reason).toContain("subject: Неверный ввод: ожидалось object, получено undefined");
  });

  it("keeps the application's own refusal text instead of the library's wording", () => {
    const schema = z.object({
      basis: z.literal("agent_inferred", { error: "AGENT_MEMORY_REVIEW_INPUT_INVALID: Тихая проверка сохраняет только выбранное моделью" }),
      subject: z.object({ kind: z.string() }),
    }).strict().superRefine((value, context) => {
      if (value.subject.kind === "label") {
        context.addIssue({ code: "custom", message: "AGENT_MEMORY_THREAD_INPUT_INVALID: Текстовая метка не задаёт identity нити", path: ["subject"] });
      }
    });

    const literal = rejectedToolCall({ error: invalidInput(schema, { basis: "user_requested", subject: { kind: "none" } }), input: {}, toolName: "remember" });
    const custom = rejectedToolCall({ error: invalidInput(schema, { basis: "agent_inferred", subject: { kind: "label" } }), input: {}, toolName: "remember" });

    expect(contractOf(literal.output).reason).toContain("basis: AGENT_MEMORY_REVIEW_INPUT_INVALID: Тихая проверка сохраняет только выбранное моделью");
    expect(contractOf(custom.output).reason).toContain("subject: AGENT_MEMORY_THREAD_INPUT_INVALID: Текстовая метка не задаёт identity нити");
    expect(custom.metrics.issues).toEqual([{ code: "custom", field: "subject" }]);
  });

  it("says when the arguments were not a JSON object at all", () => {
    const error = new InvalidToolInputError({
      cause: new JSONParseError({ cause: new SyntaxError("Unexpected end of JSON input"), text: "{\"text\":" }),
      toolInput: "{\"text\":",
      toolName: "note",
    });

    const rejected = rejectedToolCall({ error, input: "{\"text\":", toolName: "note" });

    expect(contractOf(rejected.output)).toMatchObject({ code: "AGENT_TOOL_INPUT_INVALID", retryable: true });
    expect(contractOf(rejected.output).reason).toContain("JSON");
    expect(contractOf(rejected.output).correction).not.toContain("перечисленные поля");
    expect(rejected.input).toEqual({});
    expect(rejected.metrics.issues).toEqual([{ code: "json_parse", field: "" }]);
  });

  it("tells the model a tool that is not in this conversation does not exist and does not invite a repeat", () => {
    const rejected = rejectedToolCall({ error: new NoSuchToolError({ availableTools: ["bash"], toolName: "send_fax" }), input: { to: "1" }, toolName: "send_fax" });

    expect(contractOf(rejected.output)).toMatchObject({ code: "AGENT_TOOL_UNKNOWN", retryable: false, sideEffectStatus: "not_started" });
    expect(contractOf(rejected.output).reason).toContain("send_fax");
    expect(rejected.metrics).toEqual({ errorCode: "AGENT_TOOL_UNKNOWN", issueCount: 0, issues: [] });
  });

  it("bounds a long list of problems", () => {
    const wide = z.object(Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`f${index}`, z.string()]))).strict();

    const rejected = rejectedToolCall({ error: invalidInput(wide, {}), input: {}, toolName: "probe" });

    expect(String(contractOf(rejected.output).reason)).toContain("и ещё 7");
    expect(rejected.metrics.issues).toHaveLength(5);
    expect(rejected.metrics.issueCount).toBe(12);
  });

  it("records the refusal in the tool-call metrics line without the values the model sent", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const input = { kind: "секретный текст", scope: "group", subject: { kind: "none" } };
    const rejected = rejectedToolCall({ error: invalidInput(REMEMBER_LIKE, input), input, toolName: "remember" });

    logRejectedToolCall({ callId: "call-1", metrics: rejected.metrics, sessionId: "wrun_1", toolName: "remember", turnId: "turn_1" });

    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0]![0]);
    expect(JSON.parse(line)).toEqual({
      callId: "call-1",
      code: "AGENT_TOOL_CALL_METRICS",
      durationMs: 0,
      errorCode: "AGENT_TOOL_INPUT_INVALID",
      errorDetails: { issueCount: 1, issues: [{ code: "invalid_value", field: "kind" }] },
      outcome: "failed",
      sessionId: "wrun_1",
      toolName: "remember",
      turnId: "turn_1",
    });
    expect(line).not.toContain("секретный");
  });

  it("names the allowed variants of a field that chooses between shapes", () => {
    const schema = z.object({
      thread: z.discriminatedUnion("action", [z.object({ action: z.literal("attach") }), z.object({ action: z.literal("create") })]),
    }).strict();

    const rejected = rejectedToolCall({ error: invalidInput(schema, { thread: { action: "new" } }), input: { thread: { action: "new" } }, toolName: "remember" });

    expect(contractOf(rejected.output)).toMatchObject({ field: "thread.action" });
    expect(contractOf(rejected.output).reason).toContain("ожидалось одно из \"attach\"|\"create\"");
  });

  it("names every unknown key of a nested object with its path, and keeps the metrics line short", () => {
    const schema = z.object({ subject: z.object({ kind: z.string() }).strict() }).strict();
    const input = { subject: { a: 1, b: 2, kind: "none" } };
    const many = z.object({}).strict();
    const flood = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`k${index}`, index]));

    const nested = rejectedToolCall({ error: invalidInput(schema, input), input, toolName: "remember" });
    const flooded = rejectedToolCall({ error: invalidInput(many, flood), input: flood, toolName: "remember" });

    expect(contractOf(nested.output)).toMatchObject({ field: "subject.a, subject.b" });
    expect(flooded.metrics.issues.length).toBeLessThanOrEqual(5);
    expect(flooded.metrics.issueCount).toBe(1);
    expect(flooded.metrics.issues[0]!.field.length).toBeLessThanOrEqual(120);
  });

  it("reports a refusal without a library error as an input error, not as a crash", () => {
    const rejected = rejectedToolCall({ error: undefined, input: [1, 2], toolName: "note" });

    expect(contractOf(rejected.output)).toMatchObject({ code: "AGENT_TOOL_INPUT_INVALID", retryable: true });
    expect(rejected.input).toEqual({});
  });
});
