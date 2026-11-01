/**
 * History compaction: when the prompt nears the model's window, older messages become a checkpoint.
 *
 * Exports:
 * - `compactionSettings`: the threshold (a share of the window) and the recent tail size.
 * - `shouldCompact`, `PromptMeasurement`: the provider's last count of this history plus the estimate
 *   of what came after it, or, before the provider has counted it, the estimated messages plus the
 *   system prompt and tool definitions.
 * - `providerCountStatus`: whether that count is trusted, absent or too small to be one.
 * - `compactMessages`: caps old tool results if that leaves real room under the estimate alone;
 *   otherwise a summary call replaces the older part with a checkpoint and keeps the recent tail;
 *   a summary cut at the model's output limit is asked once more, shorter, in the same compaction.
 * - `capToolResults`: the capping step on its own.
 * - `todoCompactionMessage`: the open task list, re-added after a compaction.
 * - `summarizeWithModel`, `CompactionSummaryRequest`: the summary call on the step's model.
 *
 * One summary call per compaction: when the summary with the text-only recent tail still does not
 * fit, the turn fails with a coded error instead of buying another summary call with a smaller tail.
 * A summary the model refused is not retried inside the turn either: the next message asks for a
 * smaller one, and after `COMPACTION_SUMMARY_REFUSALS_BEFORE_DROP` refusals the older part is dropped.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import { generateText, type LanguageModel, type ModelMessage } from "ai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";

import { AppError } from "../../lib/app-error.js";
import type { CompactionCounters } from "../history/history-repository.js";
import { estimateTokens } from "./compaction-estimate.js";
import {
  COMPACTION_BRIEF_SUMMARY_WORD_LIMIT,
  COMPACTION_CHECKPOINT_MARKER,
  COMPACTION_PROMPT_ENVELOPE,
  COMPACTION_RESUMPTION_MESSAGE,
  createCompactionPrompt,
  stubContentOutputFileParts,
  COMPACTION_SUMMARY_WORD_LIMIT,
  TODO_COMPACTION_PRESERVATION_LABEL,
  TRANSCRIPT_PAYLOAD_LIMIT,
  type CompactionPrompt,
} from "./compaction-prompt.js";

export interface CompactionSettings {
  readonly recentWindowSize: number;
  /**
   * Messages the application sends again by itself once compaction removed them. The summary
   * leaves them out: retold there, what they said would outlive a later withdrawal by the
   * application, which can withdraw only from its own messages.
   */
  readonly restatedAfterCompaction?: (message: ModelMessage) => boolean;
  readonly threshold: number;
}

export type Summarize = (request: CompactionPrompt) => Promise<string>;

export interface CompactionSummaryRequest extends CompactionPrompt {
  readonly abortSignal: AbortSignal;
  readonly model: LanguageModel;
  readonly providerOptions: SharedV4ProviderOptions | undefined;
}

/** The step's own model and provider options, deterministic. */
export async function summarizeWithModel(request: CompactionSummaryRequest): Promise<string> {
  const result = await generateText({
    abortSignal: request.abortSignal,
    instructions: request.system,
    model: request.model,
    prompt: request.prompt,
    providerOptions: request.providerOptions,
    temperature: 0,
  });
  return result.text;
}

const COMPACTION_RECENT_WINDOW_SIZE = 10;
/**
 * A summary request the model refuses — too large for its window by its own count, or declined
 * outright — used to be sent again on the next message, the same history at the same budget, and
 * the chat never answered again (#331). Each refusal halves the transcript the next request
 * carries; after this many in a row the older part is dropped with a notice instead of asked about.
 */
export const COMPACTION_SUMMARY_REFUSALS_BEFORE_DROP = 4;
// What replaces the older part when it could not be summarized: the model has to know the gap is
// there, or it answers as if the conversation began with the kept tail.
const COMPACTION_SUMMARY_DROPPED_CHECKPOINT =
  "The earlier part of this conversation could not be summarized: the model refused the summary request several times, so it was dropped. Nothing from it is available. If the person refers to it, say so and ask them to repeat what matters.";
// The same gap after a summary accepted earlier, which still holds.
const COMPACTION_SUMMARY_DROPPED_AFTER_CHECKPOINT =
  "The part of this conversation between the summary above and the messages that follow could not be summarized: the model refused the summary request several times, so it was dropped. The summary above still holds; nothing from the dropped part is available. If the person refers to it, say so and ask them to repeat what matters.";
const COMPACTION_SUMMARY_RESERVE_TOKENS = 2_048;
/**
 * The share of the threshold a cap of old tool results must leave free to stand in for a summary.
 * A cap that only just fits breaks the provider's cache like any rewrite, and the next few steps
 * push the history over again: on production 17 of 26 compactions in 21–31.10.2026 were such caps,
 * each followed by a summary one to eleven steps later.
 */
const CAP_MIN_FREE_SHARE = 0.2;
// The tested range of provider counts is 50-150% of the estimate. A smaller one is no count: an
// OpenAI-compatible adapter reports a missing prompt_tokens as 0 (`@ai-sdk/openai-compatible`), and
// trusting it would keep the history from ever compacting until the provider refused it.
const PROVIDER_COUNT_MIN_SHARE = 0.5;
// The code the model transport gives an answer cut at the output limit (`model-transport.ts`).
const SUMMARY_OUTPUT_TRUNCATED_CODE = "AGENT_MODEL_OUTPUT_TRUNCATED";
const CAPPED_RESULT_ANNOTATION =
  "[Truncated: tool result reduced during context compaction. Re-run the tool if you need the full output.]";

type ContentPart = Exclude<ModelMessage["content"], string>[number];

// The summarization call itself stays within threshold + envelope: its transcript is budgeted.
const COMPACTION_PROMPT_OVERHEAD_TOKENS = estimateTokens([
  { content: COMPACTION_PROMPT_ENVELOPE.system, role: "system" },
  { content: COMPACTION_PROMPT_ENVELOPE.prompt, role: "user" },
] satisfies ModelMessage[]);

export function compactionSettings(contextWindowTokens: number, thresholdPercent: number): CompactionSettings {
  return { recentWindowSize: COMPACTION_RECENT_WINDOW_SIZE, threshold: Math.max(1, Math.floor(contextWindowTokens * thresholdPercent)) };
}

/** What a compaction decision knows of a request besides its messages. */
export interface PromptMeasurement {
  /** The provider's count of this history's last request, or none since the history was replaced. */
  readonly counters: CompactionCounters;
  /** `estimateFrameTokens` of this step: the system prompt and the tool definitions. */
  readonly frameTokens: number;
}

/**
 * The estimated size the messages of a request may reach before the decision to compact. Once the
 * provider has counted this history, its count stands for the measured messages, frame included,
 * and only what came after is estimated: the estimate counts stored reasoning a provider may never
 * receive, and on production it ran 60% over the count, so a private chat compacted at 141 000 of a
 * 196 000 threshold (31.10.2026). Before that count, the frame stands beside the estimate.
 */
function decisionBudget(messages: readonly ModelMessage[], settings: CompactionSettings, measurement: PromptMeasurement): number {
  const count = trustedProviderCount(messages, measurement);
  const besides = count === null ? measurement.frameTokens : count.prior - count.prefixTokens;
  return settings.threshold - besides - COMPACTION_PROMPT_OVERHEAD_TOKENS;
}

/** The provider's count of a prefix of these messages and that prefix's estimate, or null when none covers them. */
function coveringProviderCount(messages: readonly ModelMessage[], counters: CompactionCounters) {
  const prior = counters.inputTokens;
  const priorCount = counters.promptMessageCount;
  if (prior === null || priorCount === null || !Number.isInteger(priorCount) || priorCount < 0 || priorCount > messages.length) return null;
  return { prior, prefixTokens: estimateTokens(messages.slice(0, priorCount)) };
}

function trustedProviderCount(messages: readonly ModelMessage[], measurement: PromptMeasurement) {
  const count = coveringProviderCount(messages, measurement.counters);
  if (count === null || count.prior < PROVIDER_COUNT_MIN_SHARE * (count.prefixTokens + measurement.frameTokens)) return null;
  return count;
}

/**
 * Whether a decision may lean on the provider's count: `absent` when none covers these messages,
 * `ignored` when it is too small to be one, which the turn logs, and `trusted` otherwise.
 */
export function providerCountStatus(messages: readonly ModelMessage[], measurement: PromptMeasurement): "absent" | "ignored" | "trusted" {
  if (coveringProviderCount(messages, measurement.counters) === null) return "absent";
  return trustedProviderCount(messages, measurement) === null ? "ignored" : "trusted";
}

/**
 * What a replacement must fit. The step after a compaction has no provider count yet and decides by
 * the estimate with the frame, so the replacement fits that ruler too, and the stricter of the two
 * when the provider counted more than the estimate, so that the next count does not ask again
 * either while the provider keeps counting near the ratio it counted before.
 */
function replacementBudget(messages: readonly ModelMessage[], settings: CompactionSettings, measurement: PromptMeasurement): number {
  return Math.min(
    decisionBudget(messages, settings, measurement),
    settings.threshold - measurement.frameTokens - COMPACTION_PROMPT_OVERHEAD_TOKENS,
  );
}

export function shouldCompact(messages: readonly ModelMessage[], settings: CompactionSettings, measurement: PromptMeasurement): boolean {
  return messages.length > 0 && !fits(messages, decisionBudget(messages, settings, measurement));
}

function fits(messages: readonly ModelMessage[], budget: number): boolean {
  return estimateTokens(messages) <= budget;
}

function assistantMessageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

function extractPreviousCheckpoint(messages: readonly ModelMessage[]) {
  const [marker, checkpoint] = messages;
  if (marker?.role !== "user" || marker.content !== COMPACTION_CHECKPOINT_MARKER || checkpoint?.role !== "assistant") {
    return { conversation: [...messages], previousCheckpoint: undefined };
  }
  return { conversation: messages.slice(2), previousCheckpoint: assistantMessageText(checkpoint) };
}

/** Caps each tool result once: a capped result keeps its text, which capping it again would erode. */
export function capToolResults(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool") return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") return part;
      if (part.output.type === "text" && part.output.value.startsWith(CAPPED_RESULT_ANNOTATION)) return part;
      const output = stubContentOutputFileParts(part.output) as typeof part.output;
      const serialized = JSON.stringify(output) ?? "";
      if (serialized.length <= TRANSCRIPT_PAYLOAD_LIMIT) {
        if (output === part.output) return part;
        changed = true;
        return { ...part, output };
      }
      changed = true;
      return {
        ...part,
        output: { type: "text" as const, value: `${CAPPED_RESULT_ANNOTATION}\n\n${serialized.slice(0, TRANSCRIPT_PAYLOAD_LIMIT)}` },
      };
    });
    return changed ? { ...message, content } : message;
  });
}

// Messages the runtime writes as `user` that carry no intent of the person.
function findLastRealUserMessage(conversation: readonly ModelMessage[]): ModelMessage | undefined {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index];
    if (message?.role !== "user" || typeof message.content !== "string") continue;
    if (message.content === COMPACTION_RESUMPTION_MESSAGE || message.content === COMPACTION_CHECKPOINT_MARKER ||
      message.content.startsWith(TODO_COMPACTION_PRESERVATION_LABEL)) continue;
    return message;
  }
  return undefined;
}

// Providers without assistant prefill reject a request that ends on assistant content.
function withResumptionGuard(messages: ModelMessage[], conversation: readonly ModelMessage[]): ModelMessage[] {
  const lastRole = messages.at(-1)?.role;
  if (lastRole !== undefined && lastRole !== "assistant") return messages;
  const replay = findLastRealUserMessage(conversation);
  const alreadyKept = replay !== undefined && messages.some((message) => message.role === "user" && message.content === replay.content);
  return [...messages, replay !== undefined && !alreadyKept ? replay : { content: COMPACTION_RESUMPTION_MESSAGE, role: "user" }];
}

// Tool activity leaves the kept tail, so no tool call survives without its result.
function keepNonToolResultMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  const kept: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") continue;
    if (message.role === "assistant") {
      const text = assistantMessageText(message);
      if (text.length > 0) kept.push({ content: text, role: "assistant" });
      continue;
    }
    kept.push(message);
  }
  return kept;
}

function selectRecentWindowSize(messages: readonly ModelMessage[], settings: CompactionSettings, budget: number): number {
  const maxKeep = Math.min(settings.recentWindowSize, Math.max(messages.length - 1, 0));
  const reserve = Math.min(COMPACTION_SUMMARY_RESERVE_TOKENS, Math.max(64, Math.floor(settings.threshold / 4)));
  let keep = 0;
  let recentTokens = 0;
  for (let index = messages.length - 1; index >= 0 && keep < maxKeep; index -= 1) {
    const messageTokens = estimateTokens([messages[index]]);
    if (recentTokens + messageTokens + reserve > budget) break;
    recentTokens += messageTokens;
    keep += 1;
  }
  return keep;
}

// The recent tail must not open with tool results whose calls fall into the summarized part.
function splitMessages(messages: readonly ModelMessage[], keep: number) {
  if (keep <= 0) return { older: [...messages], recent: [] as ModelMessage[] };
  let split = messages.length - keep;
  while (split < messages.length && messages[split]?.role === "tool") split += 1;
  return { older: messages.slice(0, split), recent: messages.slice(split) };
}

/** Whether the summary was cut at the output limit, also when the SDK's own retries wrapped it. */
function cutAtOutputLimit(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const { cause, code, lastError } = current as { cause?: unknown; code?: unknown; lastError?: unknown };
    if (code === SUMMARY_OUTPUT_TRUNCATED_CODE) return true;
    pending.push(cause, lastError);
  }
  return false;
}

/**
 * The summary of the older part. One cut at the model's output limit was too long, not too large to
 * read, so it is asked again at once with the brief limit instead of failing the person's message;
 * a second cut summary, or a refusal of another kind, goes to the caller as before.
 */
async function summarizeOlder(
  summarize: Summarize,
  request: (summaryWordLimit: number) => CompactionPrompt,
  summaryRefusals: number,
): Promise<string> {
  const limit = summaryRefusals > 0 ? COMPACTION_BRIEF_SUMMARY_WORD_LIMIT : COMPACTION_SUMMARY_WORD_LIMIT;
  try {
    return await summarize(request(limit));
  } catch (error) {
    if (!cutAtOutputLimit(error) || limit === COMPACTION_BRIEF_SUMMARY_WORD_LIMIT) throw error;
    console.warn(JSON.stringify({ code: "AGENT_COMPACTION_SUMMARY_TOO_LONG", summaryWordLimit: limit }));
    return await summarize(request(COMPACTION_BRIEF_SUMMARY_WORD_LIMIT));
  }
}

/**
 * `measurement` is the one `shouldCompact` decided with. `summaryRefusals` counts the summary
 * requests of this session the model refused in a row since its last compaction.
 */
export async function compactMessages(
  messages: readonly ModelMessage[],
  settings: CompactionSettings,
  summarize: Summarize,
  measurement: PromptMeasurement,
  summaryRefusals: number,
): Promise<ModelMessage[]> {
  const budget = replacementBudget(messages, settings, measurement);
  // The kept tail leaves the next steps the same room a cap must leave, or a summary would be
  // followed by another one as soon as the next tool result arrived.
  const roomAfter = Math.floor(settings.threshold * CAP_MIN_FREE_SHARE);
  const { conversation, previousCheckpoint } = extractPreviousCheckpoint(messages);
  const { older, recent } = splitMessages(conversation, selectRecentWindowSize(conversation, settings, budget - roomAfter));
  if (older.length === 0 && previousCheckpoint === undefined) return keepNonToolResultMessages(recent);

  const checkpointHead: ModelMessage[] = previousCheckpoint === undefined ? [] : [
    { content: COMPACTION_CHECKPOINT_MARKER, role: "user" },
    { content: previousCheckpoint, role: "assistant" },
  ];
  const capped = withResumptionGuard([...checkpointHead, ...capToolResults(older), ...recent], conversation);
  // A cap stands in for the summary only when it leaves real room; a near no-op goes on to the summary.
  if (fits(capped, budget - roomAfter)) return capped;

  /** The summary and the recent messages, verbatim or without tool results; `fitted` null when neither fits. */
  const withSummary = (summary: string): { fitted: ModelMessage[] | null; smallest: ModelMessage[] } => {
    const summaryHead: ModelMessage[] = [
      { content: COMPACTION_CHECKPOINT_MARKER, role: "user" },
      { content: summary, role: "assistant" },
    ];
    const verbatim = withResumptionGuard([...summaryHead, ...recent], conversation);
    if (fits(verbatim, budget)) return { fitted: verbatim, smallest: verbatim };
    const stripped = withResumptionGuard([...summaryHead, ...keepNonToolResultMessages(recent)], conversation);
    return { fitted: fits(stripped, budget) ? stripped : null, smallest: stripped };
  };
  // After the refusals the older part is dropped. A summary accepted earlier stays when the recent
  // messages still fit beside it; when they do not, it goes too, or this way out would end in a
  // history too large to send on every message, which is the dead end it exists to leave.
  const candidates = summaryRefusals >= COMPACTION_SUMMARY_REFUSALS_BEFORE_DROP
    ? [
      ...(previousCheckpoint === undefined ? [] : [`${previousCheckpoint}\n\n${COMPACTION_SUMMARY_DROPPED_AFTER_CHECKPOINT}`]),
      COMPACTION_SUMMARY_DROPPED_CHECKPOINT,
    ]
    : [await summarizeOlder(summarize, (summaryWordLimit) => createCompactionPrompt({
      messages: older.filter((message) => settings.restatedAfterCompaction?.(message) !== true),
      previousCheckpoint, strictBudget: summaryRefusals > 0, summaryWordLimit,
      transcriptBudgetTokens: Math.max(1, Math.floor(settings.threshold / 2 ** summaryRefusals)),
    }), summaryRefusals)];
  let smallest: ModelMessage[] = [];
  for (const summary of candidates) {
    const assembled = withSummary(summary);
    if (assembled.fitted !== null) return assembled.fitted;
    smallest = assembled.smallest;
  }
  throw new AppError(
    "AGENT_COMPACTION_OUTPUT_TOO_LARGE",
    "Разговор стал слишком длинным, и его не удалось сжать. Начните новый разговор",
    { details: { budgetTokens: Math.round(budget), estimatedTokens: Math.round(estimateTokens(smallest)), threshold: settings.threshold } },
  );
}

interface TodoItem {
  readonly content: string;
  readonly priority: string;
  readonly status: "cancelled" | "completed" | "in_progress" | "pending";
}

/** `todo` is the session's stored list (`{ items }`), as the todo tool keeps it. */
export function todoCompactionMessage(todo: Readonly<Record<string, unknown>> | null): ModelMessage | undefined {
  const items = (todo?.items ?? []) as readonly TodoItem[];
  if (!items.some((item) => item.status === "pending" || item.status === "in_progress")) return undefined;
  const lines = items.map((item) => {
    const check = item.status === "completed" ? "x" : item.status === "cancelled" ? "-" : " ";
    return `- [${check}] [${item.priority}] ${item.content}`;
  });
  return { content: `${TODO_COMPACTION_PRESERVATION_LABEL}\n${lines.join("\n")}`, role: "user" };
}
