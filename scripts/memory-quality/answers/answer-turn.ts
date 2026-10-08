/**
 * One answer of the production model to one stored turn, with the product's memory search at hand.
 *
 * Exports:
 * - `MAX_ANSWER_STEPS`: model requests one answer may take, tool rounds included.
 * - `AnswerOutcome` / `ModelToolCall` / `GeneratedAnswer`: what the model did and said, and its cost.
 * - `generateAnswer`: runs the request and executes `search_memories` on the rewound copy.
 *
 * The model is the configured primary model: the transport, the request shape and the
 * memory-payload projection are production's. The tool is advertised as the turn's own surface
 * advertised it, through the runtime's own conversion, and runs as the product's own
 * `search_memories` with the turn's verified rights, so a search sees memory as it stood at the
 * question. A turn whose surface had no `search_memories` gets no tool at all.
 *
 * The surface's wrappers are not run. In a private or family chat the wrapper collects messages
 * the person sent while the turn ran — on the copy that would claim stored updates and could
 * transcribe voice through the provider. In an external group it rechecks the grant this harness
 * has just read from the same copy. Neither changes what the search returns. Streamed,
 * as the runtime streams (`agent/runtime/turn/model-call.ts`): without streaming the provider sends
 * nothing until the whole answer is written, and a long one outlives the HTTP client's five-minute
 * wait for the first byte — a failure production never meets.
 *
 * What the person would have read is every step's text, as the runtime delivers it, not only the
 * last step's. A search that fails, or runs without its meaning branch, stops the run: the answer
 * would be measured against a search production did not have.
 */
import { isStepCount, streamText, type ModelMessage, type ToolSet } from "ai";

import { AppError } from "../../../agent/lib/app-error.js";
import { primaryModel } from "../../../agent/lib/model-registry.js";
import searchMemories from "../../../agent/lib/tools/search_memories.js";
import { readMemoryUsageDirective } from "../../../agent/lib/memory-usage-directive.js";
import type { SessionAuth } from "../../../agent/runtime/context.js";
import type { ToolContext, ToolDefinition } from "../../../agent/runtime/tool.js";
import { toModelToolSet } from "../../../agent/runtime/turn/model-tools.js";
import { stepTextEvents } from "../../../agent/runtime/turn/step-history.js";

/**
 * Up to four tool rounds and the answer. The search asks for at most three rephrasings; one more
 * round leaves room for a period search after them. An answer cut off here is recorded as such.
 */
export const MAX_ANSWER_STEPS = 5;

// The surface maps hold tools of different input types; the harness never relies on them here.
type AnyToolDefinition = ToolDefinition<any, any>;

const MEMORY_REF_PATTERN = /mem_[0-9a-f]{32}/gu;
const REJECTED_INPUT_CHARACTERS = 300;

/**
 * `answered` — text reached the person; `silent` — the model chose the empty-delivery marker;
 * `cut_off` — the step limit ended it during tool calls; `empty` — it returned nothing at all.
 */
export type AnswerOutcome = "answered" | "cut_off" | "empty" | "silent";

/**
 * Every tool call the model made. At most `search_memories` is offered, but the model also reaches
 * for tools it knows from the conversation history — web search, image inspection, memory writes,
 * group history — and those come back as errors without a result.
 */
export interface ModelToolCall {
  from: string | null;
  query: string | null;
  /** No result came back: a tool the harness does not offer, or input its schema refused. */
  rejected: boolean;
  /** For a rejected call, what the model actually sent, cut short; null for an accepted one. */
  rejectedInput: string | null;
  /** Records the search returned, in its order. */
  resultRefs: string[];
  to: string | null;
  /** Null only in answers recorded before the name was kept (the first run, 07.10.2026). */
  toolName: string | null;
}

export interface GeneratedAnswer {
  /** The memory refs the usage lines named, or null when the model wrote no line at all. */
  declaredRefs: string[] | null;
  finishReason: string;
  /** Null when the provider did not report it: an unknown cost is not a zero cost. */
  inputTokens: number | null;
  outcome: AnswerOutcome;
  outputTokens: number | null;
  /** Model requests the answer took. */
  requests: number;
  /** Every delivered message, usage lines removed, joined as the person would read them. */
  text: string;
  toolCalls: ModelToolCall[];
}

function searchInput(input: unknown): { from: string | null; query: string | null; to: string | null } {
  const value = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const text = (field: string) => (typeof value[field] === "string" ? value[field] as string : null);
  return { from: text("from"), query: text("query"), to: text("to") };
}

export async function generateAnswer(input: {
  auth: SessionAuth;
  messages: readonly ModelMessage[];
  /** `search_memories` as the turn's surface advertised it; null where production offered none. */
  advertisedSearchTool: AnyToolDefinition | null;
  sessionId: string;
  system: string;
  turnId: string;
}): Promise<GeneratedAnswer> {
  const abort = new AbortController();
  let searchFailure: AppError | null = null;
  const stopOnSearchFailure = (failure: AppError): never => {
    searchFailure ??= failure;
    abort.abort(failure);
    throw failure;
  };
  const context = (callId: string) => ({
    abortSignal: abort.signal,
    callId,
    session: { auth: input.auth, id: input.sessionId, turn: { id: input.turnId } },
    skills: [],
    toolName: "search_memories",
  }) as unknown as ToolContext;

  // The model gets the raw result, as the runtime gives it for a tool without a projection.
  if (searchMemories.toModelOutput !== undefined) {
    throw new AppError(
      "AGENT_MEMORY_ANSWERS_TOOL_PROJECTION_UNSUPPORTED",
      "У search_memories появилась проекция результата для модели, а харнесс её не применяет. Доработайте харнесс",
    );
  }
  const tools: ToolSet = {};
  if (input.advertisedSearchTool !== null) {
    // The same advertised form the runtime builds from a definition (`model-tools.ts`).
    const advertised = toModelToolSet([["search_memories", input.advertisedSearchTool]]).search_memories!;
    tools.search_memories = {
      ...advertised,
      execute: async (toolInput: unknown, options: { toolCallId: string }) => {
        let output: unknown;
        try {
          output = await searchMemories.execute(
            toolInput as Parameters<typeof searchMemories.execute>[0], context(options.toolCallId),
          );
        } catch (error) {
          return stopOnSearchFailure(new AppError(
            "AGENT_MEMORY_ANSWERS_SEARCH_FAILED",
            "Поиск памяти упал во время замера ответов. Проверьте копию базы и сервис векторов, затем продолжите прогон",
            { cause: error },
          ));
        }
        if (typeof output === "object" && output !== null && "incompleteSelection" in output) {
          return stopOnSearchFailure(new AppError(
            "AGENT_MEMORY_ANSWERS_SEMANTIC_UNAVAILABLE",
            "Поиск памяти отработал без смысловой ветки: сервис векторов недоступен. Поднимите его и продолжите прогон",
          ));
        }
        return output;
      },
    } as ToolSet[string];
  }

  const result = streamText({
    abortSignal: abort.signal,
    instructions: input.system,
    // No retries: a failed request stops the run, and the run resumes from the turns it finished.
    maxRetries: 0,
    messages: [...input.messages],
    model: primaryModel,
    // Errors arrive through the stream and stop the run there; the SDK would print them again.
    onError: () => {},
    stopWhen: isStepCount(MAX_ANSWER_STEPS),
    tools,
  });
  try {
    for await (const part of result.stream) {
      if (part.type === "error") throw part.error;
    }
  } catch (error) {
    if (searchFailure !== null) throw searchFailure;
    throw error;
  }
  if (searchFailure !== null) throw searchFailure;
  const [steps, finishReason, totalUsage] = await Promise.all([result.steps, result.finishReason, result.totalUsage]);

  const toolCalls = steps.flatMap((step) => step.toolCalls.map((call): ModelToolCall => {
    // A call to a tool not offered, or with input its schema refused, gets no result: the SDK
    // answers it with an error the model reads.
    const toolResult = step.toolResults.find((one) => one.toolCallId === call.toolCallId);
    return {
      ...searchInput(call.input),
      rejected: toolResult === undefined,
      rejectedInput: toolResult === undefined ? JSON.stringify(call.input ?? null).slice(0, REJECTED_INPUT_CHARACTERS) : null,
      resultRefs: toolResult === undefined
        ? []
        : [...new Set(JSON.stringify(toolResult.output).match(MEMORY_REF_PATTERN) ?? [])],
      toolName: call.toolName,
    };
  }));
  // As the runtime delivers: text before a tool call is a message of its own, and the
  // empty-delivery marker closes a turn without one.
  const events = steps.flatMap((step) => stepTextEvents(step.response.messages, step.finishReason));
  const delivered = events.flatMap((event) => event.message === null ? [] : [readMemoryUsageDirective(event.message)]);
  const text = delivered.map((one) => one.answer.trim()).filter((one) => one.length > 0).join("\n\n");
  const outcome: AnswerOutcome = text.length > 0
    ? "answered"
    : events.some((event) => event.message === null)
      ? "silent"
      : finishReason === "tool-calls" ? "cut_off" : "empty";
  return {
    declaredRefs: delivered.some((one) => one.declared) ? [...new Set(delivered.flatMap((one) => one.memoryRefs))] : null,
    finishReason,
    inputTokens: totalUsage.inputTokens ?? null,
    outcome,
    outputTokens: totalUsage.outputTokens ?? null,
    requests: steps.length,
    text,
    toolCalls,
  };
}
