/**
 * Test doubles for turn-loop integration tests: a scripted model, a recording observer, a runtime.
 *
 * Exports:
 * - `reply`, `toolCalls`: scripted model step responses as `callStepModel` returns them.
 * - `scriptedModel`: answers model calls in order and keeps every request it received.
 * - `recordingObserver`: keeps every turn event in order.
 * - `testAgent`, `testRuntime`, `newTestSession`: a runtime over the test database.
 *
 * Test-only: imported by `*.integration.test.ts` files, never by runtime code.
 */
import type { ModelMessage } from "ai";

import { database } from "../../lib/database.js";
import type { RuntimeAgent } from "../agent-definition.js";
import type { SessionAuth } from "../context.js";
import { createSessionHistory } from "../history/history-repository.js";
import { createApplicationSession } from "../history/history.integration-fixtures.js";
import { newSessionId } from "../ids.js";
import type { ToolDefinition } from "../tool.js";
import type { StepModelCall, StepModelResponse } from "./model-call.js";
import type { TurnObserver, TurnRuntime } from "./run-turn.js";
import { startTurn } from "./turn-start.js";

export const OWNER_AUTH: SessionAuth = {
  current: { attributes: { role: "owner" }, authenticator: "telegram", principalId: "telegram:912", principalType: "user" },
  initiator: { attributes: { role: "owner" }, authenticator: "telegram", principalId: "telegram:912", principalType: "user" },
};
export const TELEGRAM_CHANNEL = { kind: "telegram" };

export function reply(text: string, inputTokens = 100): StepModelResponse {
  return {
    finishReason: "stop",
    messages: [{ role: "assistant", content: [{ type: "text", text }] }],
    text,
    toolCalls: [],
    usage: { inputTokens },
  };
}

export function toolCalls(calls: ReadonlyArray<{ id: string; input: Record<string, unknown>; name: string }>, text = ""): StepModelResponse {
  return {
    finishReason: "tool-calls",
    messages: [{
      role: "assistant",
      content: [
        ...(text === "" ? [] : [{ type: "text" as const, text }]),
        ...calls.map((call) => ({ type: "tool-call" as const, toolCallId: call.id, toolName: call.name, input: call.input })),
      ],
    }],
    text,
    toolCalls: calls.map((call) => ({ input: call.input, toolCallId: call.id, toolName: call.name })),
    usage: { inputTokens: 100 },
  };
}

export type ScriptStep = StepModelResponse | ((call: StepModelCall) => StepModelResponse | Promise<StepModelResponse>);

export function scriptedModel(...steps: ScriptStep[]) {
  const requests: StepModelCall[] = [];
  return {
    requests,
    async callModel(call: StepModelCall): Promise<StepModelResponse> {
      requests.push(structuredClone({ ...call, abortSignal: undefined, model: undefined, tools: Object.keys(call.tools) }) as never);
      const step = steps[requests.length - 1];
      if (step === undefined) throw new Error(`TEST_MODEL_SCRIPT_EXHAUSTED: call ${requests.length}`);
      return typeof step === "function" ? await step(call) : step;
    },
  };
}

export type RecordedEvent = { readonly kind: string; readonly turnId: string; readonly [key: string]: unknown };

export function recordingObserver(overrides: Partial<TurnObserver> = {}) {
  const events: RecordedEvent[] = [];
  const observer: TurnObserver = {
    async turnStarted(turn) { events.push({ kind: "turnStarted", turnId: turn.id }); await overrides.turnStarted?.(turn); },
    async stepText(event) {
      events.push({ finishReason: event.finishReason, kind: "stepText", message: event.message, stepIndex: event.stepIndex, turnId: event.turn.id });
      await overrides.stepText?.(event);
    },
    async toolsStarted(event) {
      events.push({ calls: event.calls.map((call) => call.callId), kind: "toolsStarted", turnId: event.turn.id });
      await overrides.toolsStarted?.(event);
    },
    async inputRequested(event) {
      events.push({ kind: "inputRequested", requests: event.requests.map((request) => request.kind), turnId: event.turn.id });
      await overrides.inputRequested?.(event);
    },
    async turnFinished(event) {
      events.push({ kind: "turnFinished", outcome: event.outcome.status, turnId: event.turn.id });
      await overrides.turnFinished?.(event);
    },
  };
  return { events, observer };
}

export function testAgent(tools: Readonly<Record<string, ToolDefinition<any, any>>>, overrides: Partial<RuntimeAgent> = {}): RuntimeAgent {
  return {
    basePrompt: "Instructions (instructions)\nправила",
    compactionThresholdPercent: 0.75,
    instructionResolvers: [],
    maxModelSteps: 32,
    resolveSkills: async () => ({}),
    resolveTools: async () => tools,
    selectModel: ({ sessionId }) => ({
      contextWindowTokens: 200_000,
      model: "test-model-unused",
      providerOptions: { neuraldeep: { user: sessionId } },
    }),
    staticToolNames: [],
    stepStarted: async () => {},
    ...overrides,
  };
}

export function testRuntime(input: {
  readonly agent: RuntimeAgent;
  readonly callModel: TurnRuntime["callModel"];
  readonly observer: TurnObserver;
  readonly runnerId?: string;
  readonly summarize?: TurnRuntime["summarize"];
}): TurnRuntime {
  return {
    agent: input.agent,
    callModel: input.callModel,
    database: database(),
    observer: input.observer,
    runnerId: input.runnerId ?? "runner-a",
    sandbox: async () => { throw new Error("TEST_SANDBOX_UNUSED"); },
    summarize: input.summarize ?? (async () => { throw new Error("TEST_SUMMARY_UNEXPECTED"); }),
  };
}

export async function newTestSession(history: readonly ModelMessage[] = []): Promise<string> {
  const sessionId = newSessionId();
  const { applicationSessionId } = await createApplicationSession(sessionId);
  await createSessionHistory(database(), {
    announcedSkills: null, applicationSessionId, channelState: null, compaction: { inputTokens: null, promptMessageCount: null }, initiatorAuth: null,
    history, parentSessionId: null, sandbox: null, sessionId, source: "runtime", todo: null,
  });
  return sessionId;
}

export async function startMessageTurn(sessionId: string, message: string, context: readonly string[] = []) {
  return await startTurn(database(), {
    auth: OWNER_AUTH, channel: TELEGRAM_CHANNEL, input: { context, message }, kind: "conversation", parent: null, sessionId,
  });
}
