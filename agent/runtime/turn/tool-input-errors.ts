/**
 * What the model reads about a tool call that was refused before it could run.
 *
 * Exports:
 * - `rejectedToolCall`: the journal input, the model-facing result and the metrics of a call AI SDK
 *   marked invalid — its input failed the tool's schema, was not JSON, or named no tool here.
 * - `logRejectedToolCall`: the one `AGENT_TOOL_CALL_METRICS` line such a call gets.
 *
 * AI SDK 7.0.60 checks the input against the schema itself, and on a failure it puts its own error
 * text in front of the model: English, with the whole call echoed and the library's issue list as
 * JSON. The call never reaches the tool boundary, so it left no metrics line, and the journal kept
 * an empty input although AI SDK hands over what the model sent. Every other tool failure reaches
 * the model in the common contract (`lib/model-facing-error.ts`); this one now does too, field by
 * field and in Russian, so schemas can name their allowed values instead of checking them inside.
 */
import { InvalidToolInputError, JSONParseError, NoSuchToolError } from "ai";
import { z } from "zod";

import { ModelFacingError } from "../../lib/model-facing-error.js";
import { isObject } from "../json.js";
import type { ToolResultOutput } from "./tool-calls.js";

/** How many problems the reason and the metrics line list; the rest are counted. */
const LISTED_ISSUES_LIMIT = 5;
/** A field name in the metrics line, as a last bound on what a path can carry. */
const LOGGED_FIELD_MAX_CHARACTERS = 120;
// A path segment the schema itself names; anything else came from the model and is logged as `*`.
const SCHEMA_SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_]{0,63}|\d+)$/u;

interface SchemaIssue {
  readonly code?: string;
  readonly keys?: readonly string[];
  readonly message: string;
  readonly options?: readonly unknown[];
  readonly path?: readonly PropertyKey[];
}

export interface RejectedToolCallMetrics {
  readonly errorCode: string;
  readonly issueCount: number;
  readonly issues: ReadonlyArray<{ readonly code: string; readonly field: string }>;
}

export interface RejectedToolCall {
  readonly input: Record<string, unknown>;
  readonly metrics: RejectedToolCallMetrics;
  readonly output: ToolResultOutput;
}

const ENGLISH = z.locales.en().localeError;
const RUSSIAN = z.locales.ru().localeError;

function localized(map: typeof ENGLISH, issue: unknown): string | undefined {
  const result = map(issue as Parameters<typeof ENGLISH>[0]);
  return typeof result === "string" ? result : result?.message;
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let value = input;
  for (const key of path) {
    if (!isObject(value) && !Array.isArray(value)) return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}

function fieldOf(issue: SchemaIssue): string {
  const path = (issue.path ?? []).map(String);
  if (issue.code === "unrecognized_keys" && issue.keys !== undefined) {
    return issue.keys.map((key) => [...path, key].join(".")).join(", ");
  }
  return path.join(".");
}

/**
 * The field as the metrics line names it. An unknown key is the model's own text — it may carry an
 * address or a name — so the model is told it exactly, while the log keeps only where it was.
 */
function loggedFieldOf(issue: SchemaIssue): string {
  const path = (issue.path ?? []).map((segment) => SCHEMA_SEGMENT.test(String(segment)) ? String(segment) : "*");
  return (issue.code === "unrecognized_keys" ? [...path, "*"] : path).join(".").slice(0, LOGGED_FIELD_MAX_CHARACTERS);
}

/**
 * The library's own wording is replaced by its Russian locale; a message the application wrote
 * itself — a refinement or a custom error on a field — is kept as written, code included. The
 * finished issue no longer carries the value it judged, so the value is put back from the input for
 * the locale to name its type.
 */
function russianMessage(issue: SchemaIssue, input: unknown): string {
  if (issue.code === undefined || issue.code === "custom") return issue.message;
  const raw = { ...issue, input: valueAt(input, issue.path ?? []) };
  if (issue.message !== localized(ENGLISH, raw)) return issue.message;
  const russian = localized(RUSSIAN, raw) ?? issue.message;
  // The Russian locale names no variants for a field that chooses between shapes; the English one does.
  return issue.code === "invalid_union" && issue.options !== undefined && issue.options.length > 0
    ? `${russian}: ожидалось одно из ${issue.options.map((option) => JSON.stringify(option)).join("|")}`
    : russian;
}

function schemaIssues(error: InvalidToolInputError): readonly SchemaIssue[] | null {
  let cause: unknown = error.cause;
  while (isObject(cause)) {
    if (Array.isArray(cause.issues)) return cause.issues as SchemaIssue[];
    cause = cause.cause;
  }
  return null;
}

function refusalOutput(error: ModelFacingError): ToolResultOutput {
  // The same text the tool boundary's errors reach the model as (`executeToolCall`).
  return { type: "error-text", value: error.toString() };
}

function unknownToolCall(toolName: string, input: unknown): RejectedToolCall {
  return {
    input: isObject(input) ? input : {},
    metrics: { errorCode: "AGENT_TOOL_UNKNOWN", issueCount: 0, issues: [] },
    output: refusalOutput(new ModelFacingError({
      category: "input",
      code: "AGENT_TOOL_UNKNOWN",
      correction: "Вызывайте только инструменты из набора этого разговора; если нужного нет, скажите, что это действие сейчас недоступно.",
      reason: `В этом разговоре нет инструмента ${toolName}, вызов не выполнялся.`,
      retryable: false,
      sideEffectStatus: "not_started",
    })),
  };
}

function invalidInputCall(toolName: string, input: unknown, error: unknown): RejectedToolCall {
  const issues = InvalidToolInputError.isInstance(error) ? schemaIssues(error) : null;
  const notJson = InvalidToolInputError.isInstance(error) && JSONParseError.isInstance(error.cause);
  const listed = (issues ?? []).map((issue) => {
    const field = fieldOf(issue);
    const message = russianMessage(issue, input);
    return {
      code: issue.code ?? "invalid",
      field,
      loggedField: loggedFieldOf(issue),
      text: (issue.path ?? []).length > 0 ? `${field}: ${message}` : message,
    };
  });
  const shown = listed.slice(0, LISTED_ISSUES_LIMIT).map((issue) => issue.text);
  if (listed.length > LISTED_ISSUES_LIMIT) shown.push(`и ещё ${listed.length - LISTED_ISSUES_LIMIT}`);
  const reason = notJson
    ? "Аргументы вызова не являются корректным JSON-объектом."
    : shown.length > 0
      ? `Поля вызова не прошли проверку схемы: ${shown.join("; ")}.`
      : "Поля вызова не прошли проверку схемы.";
  const field = listed[0]?.field;
  const logged = notJson ? [{ code: "json_parse", field: "" }] : listed.map(({ code, loggedField }) => ({ code, field: loggedField }));
  return {
    input: isObject(input) ? input : {},
    metrics: {
      errorCode: "AGENT_TOOL_INPUT_INVALID",
      issueCount: logged.length,
      issues: logged.slice(0, LISTED_ISSUES_LIMIT),
    },
    output: refusalOutput(new ModelFacingError({
      category: "input",
      code: "AGENT_TOOL_INPUT_INVALID",
      correction: notJson
        ? `Передайте аргументы ${toolName} одним JSON-объектом по его схеме и повторите вызов один раз.`
        : `Исправьте перечисленные поля по схеме ${toolName} и повторите вызов один раз; остальные поля оставьте как были.`,
      ...(field === undefined || field === "" ? {} : { field }),
      reason,
      retryable: true,
      sideEffectStatus: "not_started",
    })),
  };
}

export function rejectedToolCall(call: { readonly error: unknown; readonly input: unknown; readonly toolName: string }): RejectedToolCall {
  return NoSuchToolError.isInstance(call.error)
    ? unknownToolCall(call.toolName, call.input)
    : invalidInputCall(call.toolName, call.input, call.error);
}

/** Field names and issue codes only: the values are the model's input and stay in the journal. */
export function logRejectedToolCall(entry: {
  readonly callId: string;
  readonly metrics: RejectedToolCallMetrics;
  readonly sessionId: string;
  readonly toolName: string;
  readonly turnId: string;
}): void {
  console.info(JSON.stringify({
    code: "AGENT_TOOL_CALL_METRICS",
    toolName: entry.toolName,
    outcome: "failed",
    sessionId: entry.sessionId,
    turnId: entry.turnId,
    callId: entry.callId,
    durationMs: 0,
    errorCode: entry.metrics.errorCode,
    ...(entry.metrics.issueCount === 0 ? {} : { errorDetails: { issueCount: entry.metrics.issueCount, issues: entry.metrics.issues } }),
  }));
}
