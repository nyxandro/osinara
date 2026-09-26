/**
 * User-facing composition of a Telegram approval message.
 *
 * Exports:
 * - `buildApprovalMessage`: fixed order of header, verified facts, agent purpose and consequence.
 * - `genericApprovalFacts`: bounded readable fields for a tool without a reviewed description.
 * - `approvalFact`, `sanitizeApprovalLine`: sanitized application-derived lines, never shortened.
 * - `googleWorkspaceFacts`: decoded service, command, flags and parameters plus the exact command.
 * - `HITL_PROMPT_CHUNK_CHARACTERS`: the longest prompt Telegram delivery sends as one message.
 *
 * Key constructs:
 * - Facts are derived from the same input that will execute, so the text cannot describe one action
 *   while another runs. The agent contributes only a labelled purpose line, never a fact.
 * - Everything is plain text: introducing Telegram markup here would add an escaping failure mode
 *   to the one message the owner's authorization depends on.
 */
import { AppError } from "../app-error.js";
import { DEFAULT_CONSEQUENCE } from "./approval-consequences.js";

// Longer prompts are delivered as numbered parts, and only the last part carries the buttons.
export const HITL_PROMPT_CHUNK_CHARACTERS = 3_000;
const PURPOSE_MAX_CHARACTERS = 300;
const GENERIC_FACT_LIMIT = 8;
const GENERIC_VALUE_MAX_CHARACTERS = 180;

export interface ApprovalMessageInput {
  actionLabel: string | null;
  consequence?: string;
  facts: readonly string[];
  /** Отдельный блок под фактами: отделяет предлагаемые значения от текущих. */
  section?: { lines: readonly string[]; title: string };
  /** Model-authored purpose. Untrusted text: labelled, flattened and bounded before display. */
  reason?: unknown;
}

/**
 * Encodes control characters as visible escapes. Unlike `flatten` this preserves the exact
 * characters, which the command line must keep, while making them unable to start a new line.
 */
function visibleEscape(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/\n/gu, "\\n")
    .replace(/\r/gu, "\\r")
    .replace(/\t/gu, "\\t")
    .replace(
      /[\p{Cc}\p{Cf}\u2028\u2029]/gu,
      (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
    );
}

/** Strips control characters and newlines so a model cannot restructure the message. */
function flatten(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function purposeLine(reason: unknown): string[] {
  if (typeof reason !== "string") return [];
  const text = flatten(reason);
  if (!text) return [];
  const bounded = text.length <= PURPOSE_MAX_CHARACTERS
    ? text
    : `${text.slice(0, PURPOSE_MAX_CHARACTERS - 1).trimEnd()}…`;
  return [`Зачем: ${bounded}`];
}

export function buildApprovalMessage(input: ApprovalMessageInput): string {
  // Reviewed labels are authored without trailing punctuation; multi-sentence ones need it back.
  // An undescribed action stays neutral: internal tool names are never shown to the user.
  const header = input.actionLabel
    ? `Подтверждение: ${/[.!?]$/u.test(input.actionLabel) ? input.actionLabel : `${input.actionLabel}.`}`
    : "Подтверждение: выполнение действия.";
  return [
    header,
    ...(input.facts.length ? [input.facts.join("\n")] : []),
    ...(input.section && input.section.lines.length
      ? [[input.section.title, ...input.section.lines].join("\n")]
      : []),
    ...purposeLine(input.reason),
    input.consequence ?? DEFAULT_CONSEQUENCE,
  ].join("\n\n");
}

function readableScalar(value: unknown): string | null {
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const text = flatten(value);
  if (!text) return null;
  return text.length <= GENERIC_VALUE_MAX_CHARACTERS
    ? text
    : `${text.slice(0, GENERIC_VALUE_MAX_CHARACTERS - 1).trimEnd()}…`;
}

/**
 * Один факт «метка: значение». Значение очищается, но НЕ сокращается: подтверждать нужно полный
 * текст, а не превью — длинное сообщение разбивается на части при доставке.
 */
export function approvalFact(label: string, value: unknown): string[] {
  if (typeof value !== "string") return [];
  const text = flatten(value);
  return text ? [`${flatten(label)}: ${text}`] : [];
}

/** Очистка уже готовой строки «метка: значение», собранной вызывающим кодом. */
export function sanitizeApprovalLine(line: string): string {
  return flatten(line);
}

export function genericApprovalFacts(input: Record<string, unknown>): string[] {
  // A tool without a reviewed description still has to say something concrete, so scalar fields of
  // the real input are shown. Structures stay hidden: they are where internal shapes leak.
  const facts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (facts.length === GENERIC_FACT_LIMIT) break;
    const readable = readableScalar(value);
    // The key is model-authored too: unflattened, a newline inside it forges an application line.
    const label = flatten(key);
    if (readable !== null && label) facts.push(`${label}: ${readable}`);
  }
  return facts;
}

function requireArgv(input: Record<string, unknown>): string[] {
  const argv = input.argv;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((item) => typeof item === "string")) {
    throw new AppError(
      "AGENT_APPROVAL_INPUT_INVALID",
      "Не удалось показать параметры команды Google Workspace",
    );
  }
  return argv;
}

function serviceLabel(service: string): string {
  const escaped = visibleEscape(service);
  return escaped.charAt(0).toUpperCase() + escaped.slice(1);
}

/** Renders `--flag value` pairs as readable lines; `--params` is decoded separately. */
function flagFacts(argv: readonly string[]): string[] {
  const facts: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--") || item === "--params" || item.startsWith("--params=")) continue;
    const value = argv[index + 1];
    // A value-arity flag whose value is missing must not be reported as an enabled switch.
    const readable = value === undefined || value.startsWith("--")
      ? "указан"
      : readableScalar(value);
    if (readable !== null) facts.push(`${flatten(item.slice(2))}: ${readable}`);
  }
  return facts;
}

/** Every `--params` payload, in both the separate and the inline `--params=` form. */
function parameterPayloads(argv: readonly string[]): string[] {
  const payloads: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (item === "--params") {
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith("--")) payloads.push(value);
      continue;
    }
    if (item.startsWith("--params=")) payloads.push(item.slice("--params=".length));
  }
  return payloads;
}

function decodedParameterFacts(argv: readonly string[]): string[] {
  // Every payload is rendered: showing only the first would describe one action while another runs.
  return parameterPayloads(argv).flatMap((raw) => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      // An undecodable payload is not an error: the exact command below still shows it verbatim.
      return [];
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return [];
    return genericApprovalFacts(decoded as Record<string, unknown>);
  });
}

export function googleWorkspaceFacts(input: Record<string, unknown>): string[] {
  const argv = requireArgv(input);
  const [service, ...rest] = argv;
  const flagIndex = rest.findIndex((item) => item.startsWith("-"));
  const command = (flagIndex === -1 ? rest : rest.slice(0, flagIndex)).map(visibleEscape).join(" ");
  return [
    `Сервис: ${serviceLabel(service!)}`,
    ...(command ? [`Команда: ${command}`] : []),
    ...flagFacts(argv),
    ...decodedParameterFacts(argv),
    // The exact argv stays visible so an approval can always be checked against what will run.
    // A multi-line argument (an email body, for example) is escaped, never allowed to add a line.
    `Точная команда: ${argv.map(visibleEscape).join(" ")}`,
  ];
}

/**
 * Removes the trailing consequence once the request is settled: an approved, cancelled or expired
 * prompt must not keep promising that the action "будет выполнено". Only an exact known sentence is
 * removed, so a prompt composed by an older release is left untouched instead of being truncated.
 */
export function stripApprovalConsequence(
  prompt: string,
  consequences: Iterable<string>,
): string {
  for (const consequence of consequences) {
    const suffix = `\n\n${consequence}`;
    if (prompt.endsWith(suffix)) return prompt.slice(0, -suffix.length);
  }
  return prompt;
}
