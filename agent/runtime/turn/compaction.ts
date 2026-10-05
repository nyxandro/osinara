/**
 * History compaction: when the prompt nears the model's window, older messages become a checkpoint.
 *
 * Exports:
 * - `compactionSettings`: the threshold (a share of the window) and the recent tail size.
 * - `shouldCompact`, `PromptMeasurement`: the estimated messages plus the system prompt and tool
 *   definitions, or plus what the provider's last count of this history showed beyond its estimate.
 * - `compactMessages`: caps old tool results if that fits the budget `shouldCompact` measured;
 *   otherwise one summary call replaces the older part with a checkpoint and keeps the recent tail.
 * - `todoCompactionMessage`: the open task list, re-added after a compaction.
 * - `summarizeWithModel`, `CompactionSummaryRequest`: the summary call on the step's model.
 *
 * One summary call per compaction: when the summary with the text-only recent tail still does not
 * fit, the turn fails with a coded error instead of buying another summary call with a smaller tail.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import { generateText, type LanguageModel, type ModelMessage } from "ai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";

import { AppError } from "../../lib/app-error.js";
import type { CompactionCounters } from "../history/history-repository.js";
import { estimateTokens } from "./compaction-estimate.js";
import {
  COMPACTION_CHECKPOINT_MARKER,
  COMPACTION_PROMPT_ENVELOPE,
  COMPACTION_RESUMPTION_MESSAGE,
  createCompactionPrompt,
  stubContentOutputFileParts,
  TODO_COMPACTION_PRESERVATION_LABEL,
  TRANSCRIPT_PAYLOAD_LIMIT,
  type CompactionPrompt,
} from "./compaction-prompt.js";

export interface CompactionSettings {
  readonly recentWindowSize: number;
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
const COMPACTION_SUMMARY_RESERVE_TOKENS = 2_048;
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
 * The estimated size the messages of a request may reach. Besides them a request carries its frame
 * or, once the provider has measured this history, what its count showed beyond the estimate of the
 * measured messages; never less than the frame, so an estimate that counts high makes no room.
 * Every decision of one compaction takes this budget: a replacement is judged by the ruler that
 * asked for it, and the next step, measured or not, does not ask again.
 */
function messageBudget(messages: readonly ModelMessage[], settings: CompactionSettings, measurement: PromptMeasurement): number {
  const { counters, frameTokens } = measurement;
  const prior = counters.inputTokens;
  const priorCount = counters.promptMessageCount;
  const measured = prior !== null && priorCount !== null && Number.isInteger(priorCount) && priorCount >= 0 && priorCount <= messages.length;
  const besides = measured ? Math.max(frameTokens, prior - estimateTokens(messages.slice(0, priorCount))) : frameTokens;
  return settings.threshold - besides - COMPACTION_PROMPT_OVERHEAD_TOKENS;
}

export function shouldCompact(messages: readonly ModelMessage[], settings: CompactionSettings, measurement: PromptMeasurement): boolean {
  return messages.length > 0 && !fits(messages, messageBudget(messages, settings, measurement));
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

function capToolResults(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool") return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") return part;
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

/** `measurement` is the one `shouldCompact` decided with. */
export async function compactMessages(
  messages: readonly ModelMessage[],
  settings: CompactionSettings,
  summarize: Summarize,
  measurement: PromptMeasurement,
): Promise<ModelMessage[]> {
  const budget = messageBudget(messages, settings, measurement);
  const { conversation, previousCheckpoint } = extractPreviousCheckpoint(messages);
  const { older, recent } = splitMessages(conversation, selectRecentWindowSize(conversation, settings, budget));
  if (older.length === 0 && previousCheckpoint === undefined) return keepNonToolResultMessages(recent);

  const checkpointHead: ModelMessage[] = previousCheckpoint === undefined ? [] : [
    { content: COMPACTION_CHECKPOINT_MARKER, role: "user" },
    { content: previousCheckpoint, role: "assistant" },
  ];
  const capped = withResumptionGuard([...checkpointHead, ...capToolResults(older), ...recent], conversation);
  // A near no-op cap stays over the budget that asked for compaction and goes on to the summary.
  if (fits(capped, budget)) return capped;

  const summary = await summarize(createCompactionPrompt({ messages: older, previousCheckpoint, transcriptBudgetTokens: settings.threshold }));
  const summaryHead: ModelMessage[] = [
    { content: COMPACTION_CHECKPOINT_MARKER, role: "user" },
    { content: summary, role: "assistant" },
  ];
  const verbatim = withResumptionGuard([...summaryHead, ...recent], conversation);
  if (fits(verbatim, budget)) return verbatim;
  const stripped = withResumptionGuard([...summaryHead, ...keepNonToolResultMessages(recent)], conversation);
  if (fits(stripped, budget)) return stripped;
  throw new AppError(
    "AGENT_COMPACTION_OUTPUT_TOO_LARGE",
    "Разговор стал слишком длинным, и его не удалось сжать. Начните новый разговор",
    { details: { budgetTokens: Math.round(budget), estimatedTokens: Math.round(estimateTokens(stripped)), threshold: settings.threshold } },
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
