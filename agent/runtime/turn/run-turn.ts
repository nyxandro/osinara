/**
 * The turn loop: model step, tool calls, history — journaled so a restart continues where it stopped.
 *
 * Exports:
 * - `runTurn`: runs a created turn to its end, to a wait for a person, or to a failure.
 * - `TurnRuntime`, `TurnObserver`, `TurnOutcome`: what the loop needs and what it reports.
 *
 * One step:
 * 1. Without a recorded response for this step, the agent's `stepStarted` runs, the model is
 *    called and its response and tool calls are recorded in one transaction. A recorded response
 *    is never requested again.
 * 2. The step's text goes to the channel once.
 * 3. Planned calls run concurrently; a call that waits for a person parks the turn.
 * 4. The turn input (on the first write), the step's messages and its tool results are appended
 *    to history together with the step's completion.
 * A continuation turn first settles the parked step it resumes (see `turn-start.ts`).
 *
 * Derived from eve 0.40.0 `harness/tool-loop.ts` (`executeStepBody`, `handleStepResult`,
 * `finishConversationTurn`) (Apache-2.0, see NOTICE-eve). Changes:
 * - The step limit is a direct check with Osinara's code instead of a blocking model.
 * - A failing instruction resolver or turn-start handler fails the turn before any model call.
 * - The tool results of a continuation are written to history before its first model call, so a
 *   failing model call cannot hide that an approved tool already ran.
 * - A delegated child's tools see their caller as `session.parent`, as Eve's subagent sessions did.
 */
import type { ModelMessage } from "ai";
import type { Pool } from "pg";

import { AppError } from "../../lib/app-error.js";
import type { RuntimeAgent, StepModelSelection } from "../agent-definition.js";
import {
  appendSessionHistory, loadSessionHistory, replaceSessionHistory, saveCompactionCounters, type SessionHistory,
} from "../history/history-repository.js";
import { renderPendingApprovalsNote } from "../hitl/input-requests.js";
import type { InputRequest } from "../hitl/types.js";
import { formatAvailableSkillsSection } from "../prompt/skills-section.js";
import { composeSystemPrompt } from "../prompt/system-prompt.js";
import { instructionTurnMessages, resolveTurnInstructions, turnInputMessages } from "../prompt/turn-instructions.js";
import type { SessionParent } from "../context.js";
import type { RuntimeSandboxSession } from "../sandbox/types.js";
import { clearReadFileState, sessionToolState } from "../session/tool-state.js";
import type { ToolContext, ToolDefinition } from "../tool.js";
import { finalOutputTool, FINAL_OUTPUT_TOOL_NAME } from "../tools/delegate.js";
import { runChildTurn } from "./child-turns.js";
import {
  claimTurn, completeStep, finishTurn, inJournalTransaction, loadStep, loadTurn, markHistoryStarted,
  markStepTextEmitted, parkToolCall, parkTurn, recordStep, savePreparedTurn, sessionAwaitsApproval, updateToolCall,
  type JournalDatabase,
} from "./journal-repository.js";
import { compactionSettings, compactMessages, shouldCompact, todoCompactionMessage, type CompactionSummaryRequest } from "./compaction.js";
import { assistantStepText, MODEL_INACTIVITY_TIMEOUT, type StepModelCall, type StepModelResponse } from "./model-call.js";
import { modelCallFailure, TurnCancelledError } from "./model-errors.js";
import { orderStepTools, toModelToolSet } from "./model-tools.js";
import { executeStepCalls, planStepCalls, type CallJournal } from "./step-calls.js";
import { prepareTurnSkills } from "./turn-skills.js";
import { isEmptyDelivery, stepHistoryMessages, stepTextEvents } from "./step-history.js";
import type { ToolResultOutput } from "./tool-calls.js";
import type { PreparedTurn, ToolCallRecord, TurnRecord } from "./turn-types.js";

export type TurnOutcome =
  | { readonly status: "completed"; readonly text: string | null }
  | { readonly status: "waiting_input"; readonly requests: readonly InputRequest[] }
  | { readonly status: "failed"; readonly code: string; readonly message: string }
  | { readonly status: "cancelled" };

/** Handlers see the turn as it was claimed; a thrown error fails the turn unless noted. */
export interface TurnObserver {
  /** Before the turn's instructions are resolved; runs again if the process died before they were saved. */
  turnStarted(turn: TurnRecord): Promise<void>;
  stepText(event: { readonly finishReason: string; readonly message: string | null; readonly stepIndex: number; readonly turn: TurnRecord }): Promise<void>;
  toolsStarted(event: { readonly calls: readonly ToolCallRecord[]; readonly stepIndex: number; readonly turn: TurnRecord }): Promise<void>;
  /** The turn is already parked; a failure here fails it, so no request stays without its buttons. */
  inputRequested(event: { readonly requests: readonly InputRequest[]; readonly stepIndex: number; readonly turn: TurnRecord }): Promise<void>;
  /** After the outcome is stored; a failure here reaches the caller, the outcome stays. */
  turnFinished(event: { readonly outcome: TurnOutcome; readonly turn: TurnRecord }): Promise<void>;
}

export interface TurnRuntime {
  readonly agent: RuntimeAgent;
  readonly callModel: (input: StepModelCall) => Promise<StepModelResponse>;
  readonly database: JournalDatabase & Pick<Pool, "query">;
  readonly observer: TurnObserver;
  readonly runnerId: string;
  readonly sandbox: (session: { readonly auth: TurnRecord["auth"]; readonly id: string }) => Promise<RuntimeSandboxSession>;
  /** The one summary call of a history compaction (`summarizeWithModel`). */
  readonly summarize: (request: CompactionSummaryRequest) => Promise<string>;
}

type AnyTools = Readonly<Record<string, ToolDefinition<any, any>>>;

const TURN_FAILED_MESSAGE = "Не удалось выполнить ход агента. Попробуйте ещё раз";

// Model-facing: a delegating parent reads it as the result of its `agent` call.
function outputSchemaNotFulfilled(): AppError {
  return new AppError("AGENT_SUBAGENT_OUTPUT_SCHEMA_NOT_FULFILLED", "The agent could not produce a result matching the requested schema.");
}

function stepLimitExceeded(): AppError {
  return new AppError(
    "AGENT_TURN_MODEL_STEP_LIMIT_EXCEEDED",
    "Агент остановил выполнение, потому что запрос потребовал слишком много шагов. Разбейте задачу на части и повторите",
  );
}

function requirePrepared(turn: TurnRecord): PreparedTurn {
  if (turn.prepared === null) throw new Error(`AGENT_TURN_NOT_PREPARED: turn ${turn.id} has no prepared instructions`);
  return turn.prepared;
}

function systemPrompt(agent: RuntimeAgent, prepared: PreparedTurn): string {
  if (prepared.skills.length > 0 && prepared.skillRoot === null) {
    throw new Error("AGENT_TURN_SKILL_ROOT_MISSING: skills are listed without a sandbox skill root");
  }
  return composeSystemPrompt({
    base: agent.basePrompt,
    instructionBlocks: prepared.instructions,
    skillsSection: prepared.skillRoot === null ? null : formatAvailableSkillsSection(prepared.skills, { skillRoot: prepared.skillRoot }),
  });
}

/** A delegated child's caller, as its tools and step hook see it; one level deep. */
async function sessionParent(runtime: TurnRuntime, turn: TurnRecord): Promise<SessionParent | undefined> {
  if (turn.parentTurnId === null || turn.parentCallId === null) return undefined;
  const parent = await loadTurn(runtime.database, turn.parentTurnId);
  return {
    callId: turn.parentCallId, rootSessionId: parent.sessionId, sessionId: parent.sessionId,
    turn: { id: parent.id, sequence: parent.sequence },
  };
}

function sessionOf(turn: TurnRecord, parent: SessionParent | undefined) {
  return { auth: turn.auth, id: turn.sessionId, ...(parent === undefined ? {} : { parent }), turn: { id: turn.id, sequence: turn.sequence } };
}

function toolContexts(runtime: TurnRuntime, turn: TurnRecord, parent: SessionParent | undefined, abortSignal: AbortSignal) {
  let sandbox: Promise<RuntimeSandboxSession> | undefined;
  const session = sessionOf(turn, parent);
  const state = sessionToolState(runtime.database, turn.sessionId);
  const skills = requirePrepared(turn).skills.map((skill) => skill.name);
  return (call: { readonly callId: string; readonly toolName: string }): ToolContext => ({
    abortSignal,
    callId: call.callId,
    getSandbox: () => (sandbox ??= runtime.sandbox({ auth: turn.auth, id: turn.sessionId })),
    session,
    skills,
    state,
    toolName: call.toolName,
  });
}

function callJournal(runtime: TurnRuntime, turnId: string): CallJournal {
  return {
    markIntent: (callId) => updateToolCall(runtime.database, { callId, output: null, state: "intent", turnId }),
    park: (callId, request) => parkToolCall(runtime.database, { callId, request, turnId }),
    settle: (callId, state, output) => updateToolCall(runtime.database, { callId, output, state, turnId }),
  };
}

// The tools of one step; a child asked for structured output also gets `final_output`, last.
async function stepTools(runtime: TurnRuntime, turn: TurnRecord, messages: readonly ModelMessage[]): Promise<AnyTools> {
  const tools = await runtime.agent.resolveTools({ channel: turn.channel, messages, session: { auth: turn.auth, id: turn.sessionId } });
  const schema = turn.input.outputSchema;
  return schema === undefined ? tools : { ...tools, [FINAL_OUTPUT_TOOL_NAME]: finalOutputTool(schema) };
}

// A `final_output` call ends a structured child turn, even beside other calls (Eve's rule).
function structuredOutput(turn: TurnRecord, response: readonly ModelMessage[]): { readonly value: unknown } | null {
  if (turn.input.outputSchema === undefined) return null;
  for (const message of response) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    const call = message.content.find((part) => part.type === "tool-call" && part.toolName === FINAL_OUTPUT_TOOL_NAME);
    if (call !== undefined && call.type === "tool-call" && call.input !== null && typeof call.input === "object") return { value: call.input };
  }
  return null;
}

function withOutputs(calls: readonly ToolCallRecord[]) {
  return calls.map((call) => {
    if (call.output === null) throw new Error(`AGENT_TURN_CALL_UNSETTLED: call ${call.callId} has no result`);
    return { callId: call.callId, output: call.output as ToolResultOutput, toolName: call.toolName };
  });
}

async function runCalls(runtime: TurnRuntime, input: {
  readonly calls: readonly ToolCallRecord[];
  readonly journalTurnId: string;
  readonly parent: SessionParent | undefined;
  readonly signal: AbortSignal;
  readonly stepIndex: number;
  readonly tools: AnyTools;
  readonly turn: TurnRecord;
}): Promise<ToolCallRecord[]> {
  const runnable = input.calls.filter((call) => call.state === "planned" || call.state === "intent");
  if (runnable.length === 0) return [...input.calls];
  await runtime.observer.toolsStarted({ calls: runnable, stepIndex: input.stepIndex, turn: input.turn });
  return await executeStepCalls({
    calls: input.calls,
    contextFor: toolContexts(runtime, input.turn, input.parent, input.signal),
    delegateCall: (call) => runChildTurn(runtime, {
      call, journalTurnId: input.journalTurnId, parent: input.turn, run: runTurn, signal: input.signal,
    }),
    journal: callJournal(runtime, input.journalTurnId),
    tools: input.tools,
  });
}

async function prepareTurn(runtime: TurnRuntime, turn: TurnRecord): Promise<TurnRecord> {
  if (turn.prepared !== null) return turn;
  await runtime.observer.turnStarted(turn);
  const history = await loadSessionHistory(runtime.database, turn.sessionId);
  const context = {
    channel: turn.channel,
    messages: instructionTurnMessages(history.messages, turn.input),
    session: { auth: turn.auth, id: turn.sessionId },
    turnId: turn.id,
  };
  const [instructions, definitions] = await Promise.all([
    resolveTurnInstructions(runtime.agent.instructionResolvers, context),
    runtime.agent.resolveSkills(context),
  ]);
  const skills = await prepareTurnSkills({
    database: runtime.database,
    definitions,
    previous: history.announcedSkills,
    sandbox: () => runtime.sandbox({ auth: turn.auth, id: turn.sessionId }),
    sessionId: turn.sessionId,
  });
  const prepared: PreparedTurn = {
    instructions: instructions.system, skillRoot: skills.skillRoot, skills: skills.skills, userInstructions: instructions.user,
  };
  await savePreparedTurn(runtime.database, turn.id, prepared);
  return { ...turn, prepared };
}

/** A continuation runs the approved calls of the parked step and writes that step into history. */
async function settleParkedStep(
  runtime: TurnRuntime, turn: TurnRecord, parent: SessionParent | undefined, signal: AbortSignal,
): Promise<TurnRecord> {
  const parked = await loadTurn(runtime.database, turn.resumesTurnId!);
  const recorded = await loadStep(runtime.database, parked.id, parked.nextStepIndex);
  if (recorded === null || recorded.calls.some((call) => call.state === "awaiting_input")) {
    throw new Error(`AGENT_TURN_CONTINUATION_INVALID: turn ${parked.id} has no settled parked step`);
  }
  const history = await loadSessionHistory(runtime.database, turn.sessionId);
  const tools = await stepTools(runtime, turn, history.messages);
  const calls = await runCalls(runtime, { calls: recorded.calls, journalTurnId: parked.id, parent, signal, stepIndex: 0, tools, turn });
  if (calls.some((call) => call.state === "awaiting_input")) {
    throw new Error(`AGENT_TURN_CONTINUATION_INVALID: a call of turn ${parked.id} still waits after its answer`);
  }
  const prepared = requirePrepared(turn);
  const message = turnInputMessages({ context: [], message: turn.input.message, userInstructions: [] });
  const context = turn.input.context.map((entry): ModelMessage => ({ role: "user", content: entry }));
  // Eve's order (with Osinara's hitl-context patch): a button press puts its context lines before
  // the restored transcript; a new message that dismissed a question comes after it, as usual.
  const messages = [
    ...prepared.userInstructions,
    ...(message.length === 0 ? context : []),
    ...stepHistoryMessages({ calls: withOutputs(calls), response: recorded.step.response }),
    ...(message.length === 0 ? [] : [...context, ...message]),
  ];
  await inJournalTransaction(runtime.database, async (client) => {
    await appendSessionHistory(client, { messages, sessionId: turn.sessionId, turnId: turn.id });
    await completeStep(client, parked.id, parked.nextStepIndex);
    await markHistoryStarted(client, turn.id);
  });
  return { ...turn, historyStarted: true };
}

/** Returns the compacted prompt messages, now the session's history, or `null` when none was needed. */
async function compactIfNeeded(runtime: TurnRuntime, input: {
  readonly history: SessionHistory;
  readonly messages: readonly ModelMessage[];
  readonly selection: StepModelSelection;
  readonly signal: AbortSignal;
  readonly turn: TurnRecord;
}): Promise<ModelMessage[] | null> {
  const settings = compactionSettings(input.selection.contextWindowTokens, runtime.agent.compactionThresholdPercent);
  if (!shouldCompact(input.messages, settings, input.history.compaction)) return null;
  let compacted: ModelMessage[];
  try {
    compacted = await compactMessages(input.messages, settings, (request) => runtime.summarize({
      ...request, abortSignal: input.signal, model: input.selection.model, providerOptions: input.selection.providerOptions,
    }));
  } catch (error) {
    throw modelCallFailure(error);
  }
  const todo = todoCompactionMessage(input.history.todo);
  const messages = todo === undefined ? compacted : [...compacted, todo];
  // The turn input is part of the compacted history now, so it is not appended again. What the
  // model read is summarized away, so a write must read the file again (Eve's compaction reset).
  await inJournalTransaction(runtime.database, async (client) => {
    await replaceSessionHistory(client, { messages, sessionId: input.turn.sessionId, turnId: input.turn.id });
    await clearReadFileState(client, input.turn.sessionId);
    await markHistoryStarted(client, input.turn.id);
  });
  return messages;
}

async function callModel(runtime: TurnRuntime, input: {
  readonly messages: readonly ModelMessage[];
  readonly selection: StepModelSelection;
  readonly signal: AbortSignal;
  readonly tools: AnyTools;
  readonly turn: TurnRecord;
}): Promise<StepModelResponse> {
  const { agent } = runtime;
  const { selection } = input;
  // While an approval waits, other turns of the session answer without tools, as Eve did.
  const toolChoice = await sessionAwaitsApproval(runtime.database, input.turn.sessionId) ? "none" : undefined;
  try {
    return await runtime.callModel({
      abortSignal: input.signal,
      inactivity: MODEL_INACTIVITY_TIMEOUT,
      messages: input.messages,
      model: selection.model,
      providerOptions: selection.providerOptions,
      system: systemPrompt(agent, requirePrepared(input.turn)),
      toolChoice,
      tools: toModelToolSet(orderStepTools(input.tools, agent.staticToolNames)),
    });
  } catch (error) {
    throw modelCallFailure(error);
  }
}

function inputTokens(usage: unknown): number | undefined {
  const value = (usage as { inputTokens?: unknown } | undefined)?.inputTokens;
  return typeof value === "number" ? value : undefined;
}

/** Runs one step; returns the outcome when the turn ends or parks, `null` to continue. */
async function runStep(
  runtime: TurnRuntime, turn: TurnRecord, parent: SessionParent | undefined, signal: AbortSignal,
): Promise<TurnOutcome | null> {
  const stepIndex = turn.nextStepIndex;
  const prepared = requirePrepared(turn);
  const history = await loadSessionHistory(runtime.database, turn.sessionId);
  let turnInput = turn.historyStarted ? [] : turnInputMessages({ ...turn.input, userInstructions: prepared.userInstructions });
  let messages = [...history.messages, ...turnInput];
  const tools = await stepTools(runtime, turn, messages);
  let recorded = await loadStep(runtime.database, turn.id, stepIndex);
  if (recorded === null) {
    if (stepIndex >= runtime.agent.maxModelSteps) throw stepLimitExceeded();
    const selection = runtime.agent.selectModel({ sessionId: turn.sessionId, stepIndex });
    const compacted = await compactIfNeeded(runtime, { history, messages, selection, signal, turn });
    if (compacted !== null) {
      messages = compacted;
      turnInput = [];
    }
    await runtime.agent.stepStarted({ channel: turn.channel, session: sessionOf(turn, parent) });
    const response = await callModel(runtime, { messages, selection, signal, tools, turn });
    const calls = await planStepCalls({
      contextFor: toolContexts(runtime, turn, parent, signal), response: response.messages, toolCalls: response.toolCalls, tools,
    });
    await inJournalTransaction(runtime.database, async (client) => {
      await recordStep(client, {
        calls, finishReason: response.finishReason, response: response.messages, stepIndex, turnId: turn.id, usage: response.usage,
      });
      const tokens = inputTokens(response.usage);
      if (tokens !== undefined) {
        await saveCompactionCounters(client, {
          counters: { inputTokens: tokens, promptMessageCount: messages.length }, sessionId: turn.sessionId,
        });
      }
    });
    recorded = {
      calls: calls.map((call) => ({ ...call, stepIndex })),
      step: { completed: false, finishReason: response.finishReason, response: response.messages, stepIndex, textEmitted: false },
    };
  }
  const { step } = recorded;
  if (!step.textEmitted) {
    for (const event of stepTextEvents(step.response, step.finishReason)) {
      await runtime.observer.stepText({ ...event, stepIndex, turn });
    }
    await markStepTextEmitted(runtime.database, turn.id, stepIndex);
  }

  const structured = structuredOutput(turn, step.response);
  if (structured !== null) {
    const answer = JSON.stringify(structured.value);
    await inJournalTransaction(runtime.database, async (client) => {
      // The structured value is the turn's answer; the unexecuted call stays out of history.
      const messages: ModelMessage[] = [...turnInput, { role: "assistant", content: answer }];
      await appendSessionHistory(client, { messages, sessionId: turn.sessionId, turnId: turn.id });
      await completeStep(client, turn.id, stepIndex);
      await finishTurn(client, turn.id, { finalText: answer, status: "completed" });
    });
    return { status: "completed", text: answer };
  }
  if (recorded.calls.length === 0) {
    if (turn.input.outputSchema !== undefined) throw outputSchemaNotFulfilled();
    const text = assistantStepText(step.response);
    const silent = isEmptyDelivery({ finishReason: step.finishReason, text, toolCallCount: 0 });
    const finalText = silent ? null : text;
    await inJournalTransaction(runtime.database, async (client) => {
      const stepMessages = silent ? [] : stepHistoryMessages({ calls: [], response: step.response });
      await appendSessionHistory(client, { messages: [...turnInput, ...stepMessages], sessionId: turn.sessionId, turnId: turn.id });
      await completeStep(client, turn.id, stepIndex);
      await finishTurn(client, turn.id, { finalText, status: "completed" });
    });
    return { status: "completed", text: finalText };
  }

  const calls = await runCalls(runtime, { calls: recorded.calls, journalTurnId: turn.id, parent, signal, stepIndex, tools, turn });
  const own = calls.flatMap((call) => call.state === "awaiting_input" && call.inputRequest !== null && call.inputRequest.kind !== "subagent"
    ? [call.inputRequest] : []);
  const proxied = calls.flatMap((call) => call.state === "awaiting_input" && call.inputRequest?.kind === "subagent"
    ? call.inputRequest.requests : []);
  const requests = [...own, ...proxied];
  if (requests.length > 0) {
    // A child's approvals are noted in the child's history; the parent only waits for its result.
    const note = renderPendingApprovalsNote(own);
    await inJournalTransaction(runtime.database, async (client) => {
      const parkedMessages: ModelMessage[] = note === undefined ? [] : [{ role: "user", content: note }];
      await appendSessionHistory(client, { messages: [...turnInput, ...parkedMessages], sessionId: turn.sessionId, turnId: turn.id });
      await parkTurn(client, turn.id);
    });
    await runtime.observer.inputRequested({ requests, stepIndex, turn });
    return { requests, status: "waiting_input" };
  }
  await inJournalTransaction(runtime.database, async (client) => {
    const stepMessages = stepHistoryMessages({ calls: withOutputs(calls), response: step.response });
    await appendSessionHistory(client, { messages: [...turnInput, ...stepMessages], sessionId: turn.sessionId, turnId: turn.id });
    await completeStep(client, turn.id, stepIndex);
  });
  return null;
}

async function driveTurn(runtime: TurnRuntime, claimed: TurnRecord, signal: AbortSignal): Promise<TurnOutcome> {
  const parent = await sessionParent(runtime, claimed);
  let turn = await prepareTurn(runtime, claimed);
  if (turn.resumesTurnId !== null && !turn.historyStarted) turn = await settleParkedStep(runtime, turn, parent, signal);
  for (;;) {
    const outcome = await runStep(runtime, turn, parent, signal);
    if (outcome !== null) return outcome;
    turn = await loadTurn(runtime.database, turn.id);
  }
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return error instanceof TurnCancelledError || signal.aborted;
}

async function failTurn(runtime: TurnRuntime, turn: TurnRecord, error: unknown, signal: AbortSignal): Promise<TurnOutcome> {
  if (isCancellation(error, signal)) {
    await finishTurn(runtime.database, turn.id, { status: "cancelled" });
    return { status: "cancelled" };
  }
  const code = error instanceof AppError ? error.code : "AGENT_TURN_FAILED";
  const message = error instanceof AppError ? error.message.slice(code.length + 2) : TURN_FAILED_MESSAGE;
  console.error(JSON.stringify({
    code: "AGENT_TURN_FAILED",
    error: error instanceof Error ? error.message : String(error),
    errorCode: code,
    ...(error instanceof AppError && error.details !== undefined ? { details: error.details } : {}),
    ...(error instanceof Error && error.cause instanceof Error ? { cause: error.cause.message } : {}),
    sessionId: turn.sessionId,
    turnId: turn.id,
  }));
  await finishTurn(runtime.database, turn.id, { errorCode: code, errorMessage: message, status: "failed" });
  return { code, message, status: "failed" };
}

/** Returns `busy` when another live process owns the turn or it is no longer running. */
export async function runTurn(
  runtime: TurnRuntime,
  turnId: string,
  options: { readonly abortSignal: AbortSignal },
): Promise<TurnOutcome | { readonly status: "busy" }> {
  const claimed = await claimTurn(runtime.database, turnId, runtime.runnerId);
  if (claimed === null) return { status: "busy" };
  let outcome: TurnOutcome;
  try {
    outcome = await driveTurn(runtime, claimed, options.abortSignal);
  } catch (error) {
    outcome = await failTurn(runtime, claimed, error, options.abortSignal);
  }
  await runtime.observer.turnFinished({ outcome, turn: claimed });
  return outcome;
}
