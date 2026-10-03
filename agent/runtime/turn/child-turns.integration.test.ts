import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { closeDatabase, database } from "../../lib/database.js";
import { loadSessionHistory } from "../history/history-repository.js";
import { newTurnId } from "../ids.js";
import { defineTool, type ToolDefinition } from "../tool.js";
import { agentTool } from "../tools/delegate.js";
import type { StepModelCall, StepModelResponse } from "./model-call.js";
import { runTurn } from "./run-turn.js";
import { respondToInput } from "./turn-start.js";
import {
  newTestSession, OWNER_AUTH, recordingObserver, reply, startMessageTurn, testAgent, testRuntime, toolCalls,
} from "./turn.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");

const RUN = { abortSignal: new AbortController().signal };
const never = <T>() => new Promise<T>(() => {});

// One model for parent and children: a child is recognized by its task message.
function routedModel(route: (call: StepModelCall, task: string | null) => StepModelResponse | Promise<StepModelResponse>) {
  const requests: Array<{ messages: StepModelCall["messages"]; task: string | null; tools: string[] }> = [];
  return {
    requests,
    async callModel(call: StepModelCall) {
      const first = call.messages.find((message) => message.role === "user" && typeof message.content === "string" &&
        message.content.startsWith('You are the subagent "agent".'));
      const task = first === undefined ? null : (first.content as string).split("Caller message:\n")[1]!;
      requests.push({ messages: structuredClone(call.messages), task, tools: Object.keys(call.tools) });
      return await route(call, task);
    },
  };
}

const delegateTo = (...tasks: Array<{ id: string; message: string; outputSchema?: object }>) =>
  toolCalls(tasks.map((task) => ({ id: task.id, input: { message: task.message, ...(task.outputSchema ? { outputSchema: task.outputSchema } : {}) }, name: "agent" })));

function hasResult(call: StepModelCall): boolean {
  return call.messages.at(-1)?.role === "tool";
}

async function childTurns() {
  return (await database().query<{ auth: unknown; channel: { kind: string }; session_id: string; status: string }>(
    "SELECT session_id, auth, channel, status FROM agent_turns WHERE kind = 'subagent' ORDER BY created_at",
  )).rows;
}

(enabled ? describe : describe.skip)("child turns", () => {
  beforeEach(async () => { await database().query("TRUNCATE users, families CASCADE"); });
  afterAll(closeDatabase);

  it("runs a delegated task in a fresh session and returns its answer as the tool result", async () => {
    const sessionId = await newTestSession([{ role: "user", content: "старое" }, { role: "assistant", content: [{ type: "text", text: "давно" }] }]);
    const channels: string[] = [];
    const model = routedModel((call, task) => {
      if (task !== null) return reply(`сделано: ${task}`);
      return hasResult(call) ? reply("Готово.") : delegateTo({ id: "call-a", message: "посчитай" });
    });
    const agent = testAgent({ agent: agentTool }, {
      resolveTools: async (ctx): Promise<Record<string, typeof agentTool>> => {
        channels.push(ctx.channel.kind ?? "");
        return ctx.channel.kind === "subagent" ? {} : { agent: agentTool };
      },
    });
    const turn = await startMessageTurn(sessionId, "сделай");

    const outcome = await runTurn(testRuntime({ agent, callModel: model.callModel, observer: recordingObserver().observer }), turn.id, RUN);

    expect(outcome).toEqual({ status: "completed", text: "Готово." });
    const child = model.requests.find((request) => request.task !== null)!;
    expect(child.messages).toEqual([{ role: "user", content: 'You are the subagent "agent".\n\nThe caller delegated the following task to you. Complete it and return the final result directly.\n\nCaller message:\nпосчитай' }]);
    expect(model.requests.at(-1)!.messages.at(-1)).toEqual({ role: "tool", content: [{
      type: "tool-result", toolCallId: "call-a", toolName: "agent", output: { type: "text", value: "сделано: посчитай" },
    }] });
    expect(channels).toContain("subagent");
    const [row] = await childTurns();
    expect(row).toMatchObject({ auth: OWNER_AUTH, channel: { kind: "subagent" }, status: "completed" });
    expect((await loadSessionHistory(database(), sessionId)).messages).toHaveLength(6);
  });

  it("shows a delegated task's tools and step hook who called it, and the root turn no caller", async () => {
    const sessionId = await newTestSession();
    const parents: Array<{ seenBy: string; parent: unknown }> = [];
    const probe = defineTool({
      description: "probe",
      inputSchema: z.object({}),
      async execute(_input, ctx) { parents.push({ parent: ctx.session.parent, seenBy: "tool" }); return "ok"; },
    });
    const model = routedModel((call, task) => {
      if (task !== null) return hasResult(call) ? reply("проверено") : toolCalls([{ id: "call-probe", input: {}, name: "probe" }]);
      return hasResult(call) ? reply("Готово.") : delegateTo({ id: "call-a", message: "проверь" });
    });
    const agent = testAgent({ agent: agentTool }, {
      resolveTools: async (ctx): Promise<Record<string, ToolDefinition<any, any>>> => ctx.channel.kind === "subagent" ? { probe } : { agent: agentTool },
      stepStarted: async (ctx) => { parents.push({ parent: ctx.session.parent, seenBy: `step:${ctx.channel.kind}` }); },
    });
    const turn = await startMessageTurn(sessionId, "делегируй");

    await runTurn(testRuntime({ agent, callModel: model.callModel, observer: recordingObserver().observer }), turn.id, RUN);

    const caller = { callId: "call-a", rootSessionId: sessionId, sessionId, turn: { id: turn.id, sequence: turn.sequence } };
    expect(parents).toEqual([
      { parent: undefined, seenBy: "step:telegram" },
      { parent: caller, seenBy: "step:subagent" },
      { parent: caller, seenBy: "tool" },
      { parent: caller, seenBy: "step:subagent" },
      { parent: undefined, seenBy: "step:telegram" },
    ]);
  });

  it("runs several delegated tasks of one step at the same time", async () => {
    const sessionId = await newTestSession();
    let running = 0;
    let peak = 0;
    const model = routedModel(async (call, task) => {
      if (task === null) return hasResult(call) ? reply("Оба готовы.") : delegateTo({ id: "call-a", message: "а" }, { id: "call-b", message: "б" });
      running += 1;
      peak = Math.max(peak, running);
      await vi.waitFor(() => expect(peak).toBe(2));
      running -= 1;
      return reply(`ответ ${task}`);
    });
    const turn = await startMessageTurn(sessionId, "оба");

    await runTurn(testRuntime({ agent: testAgent({ agent: agentTool }), callModel: model.callModel, observer: recordingObserver().observer }), turn.id, RUN);

    expect(peak).toBe(2);
    expect(model.requests.at(-1)!.messages.at(-1)).toMatchObject({ content: [
      { output: { value: "ответ а" }, toolCallId: "call-a" }, { output: { value: "ответ б" }, toolCallId: "call-b" },
    ] });
  });

  it("returns a structured answer through final_output when the caller asked for a schema", async () => {
    const sessionId = await newTestSession();
    const schema = { type: "object", properties: { total: { type: "number" } }, required: ["total"] };
    const model = routedModel((call, task) => {
      if (task !== null) return toolCalls([{ id: "call-f", input: { total: 42 }, name: "final_output" }]);
      return hasResult(call) ? reply("42") : delegateTo({ id: "call-a", message: "сумма", outputSchema: schema });
    });
    const turn = await startMessageTurn(sessionId, "посчитай");

    await runTurn(testRuntime({ agent: testAgent({ agent: agentTool }), callModel: model.callModel, observer: recordingObserver().observer }), turn.id, RUN);

    expect(model.requests.find((request) => request.task !== null)!.tools.at(-1)).toBe("final_output");
    expect(model.requests.at(-1)!.messages.at(-1)).toMatchObject({ content: [{ output: { type: "json", value: { total: 42 } }, toolCallId: "call-a" }] });
  });

  it("reports a failed child to the parent model instead of failing the parent", async () => {
    const sessionId = await newTestSession();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const model = routedModel((call, task) => {
      if (task !== null) throw new Error("provider down");
      return hasResult(call) ? reply("Не вышло.") : delegateTo({ id: "call-a", message: "x" });
    });
    const turn = await startMessageTurn(sessionId, "делай");

    const outcome = await runTurn(testRuntime({ agent: testAgent({ agent: agentTool }), callModel: model.callModel, observer: recordingObserver().observer }), turn.id, RUN);

    expect(outcome).toEqual({ status: "completed", text: "Не вышло." });
    expect(model.requests.at(-1)!.messages.at(-1)).toMatchObject({ content: [{ output: { type: "error-text", value: expect.stringMatching(/^AGENT_MODEL_CALL_FAILED: /) } }] });
    vi.restoreAllMocks();
  });

  it("shows a child's approval to the person and continues the child, then the parent", async () => {
    const sessionId = await newTestSession();
    const callers: unknown[] = [];
    const execute = vi.fn(async (_input: unknown, ctx: { session: { parent?: unknown } }) => { callers.push(ctx.session.parent); return "отправлено"; });
    const send = defineTool({ approval: () => "user-approval" as const, description: "Отправить", execute, inputSchema: z.object({ to: z.string() }) });
    const model = routedModel((call, task) => {
      if (task !== null) return hasResult(call) ? reply("письмо ушло") : toolCalls([{ id: "call-s", input: { to: "a@b" }, name: "send" }]);
      return hasResult(call) ? reply("Отправил.") : delegateTo({ id: "call-a", message: "отправь" });
    });
    const agent = testAgent({ agent: agentTool, send });
    const { events, observer } = recordingObserver();
    const turn = await startMessageTurn(sessionId, "отправь письмо");

    const parked = await runTurn(testRuntime({ agent, callModel: model.callModel, observer }), turn.id, RUN);
    if (parked.status !== "waiting_input") throw new Error(parked.status);
    expect(parked.requests).toMatchObject([{ action: { toolName: "send" }, kind: "tool-approval" }]);
    expect(events.filter((event) => event.kind === "inputRequested")).toHaveLength(1);
    // The parent waits for its child's result; the approval note lives in the child's history.
    expect((await loadSessionHistory(database(), sessionId)).messages).toEqual([{ role: "user", content: "отправь письмо" }]);

    const resumed = await respondToInput(database(), {
      auth: OWNER_AUTH, context: [], responses: [{ optionId: "approve", requestId: parked.requests[0]!.requestId }], sessionId,
    });
    if (resumed.status !== "resumed") throw new Error(resumed.status);
    const final = await runTurn(testRuntime({ agent, callModel: model.callModel, observer: recordingObserver().observer }), resumed.continuation.id, RUN);

    expect(final).toEqual({ status: "completed", text: "Отправил." });
    expect(execute).toHaveBeenCalledTimes(1);
    // The approved call runs in the child's continuation, which is still the caller's subagent.
    expect(callers).toEqual([expect.objectContaining({ callId: "call-a", sessionId, turn: expect.objectContaining({ id: turn.id }) })]);
    // The child continues as a child: with its own channel, not the parent's.
    const childContinuations = await database().query<{ channel: unknown }>(
      "SELECT channel FROM agent_turns WHERE resumes_turn_id IS NOT NULL AND session_id <> $1", [sessionId]);
    expect(childContinuations.rows).toEqual([{ channel: { kind: "subagent" } }]);
    expect(model.requests.at(-1)!.messages.at(-1)).toMatchObject({ content: [{ output: { type: "text", value: "письмо ушло" }, toolCallId: "call-a" }] });
  });

  it("fails a subagent turn whose caller cannot be found instead of running it as the main agent", async () => {
    const parentSession = await newTestSession();
    const childSession = await newTestSession([], { parentSessionId: parentSession });
    const orphan = (await database().query<{ id: string }>(
      `INSERT INTO agent_turns (id, session_id, sequence, kind, status, auth, channel, input)
       VALUES ($2, $1, 0, 'subagent', 'running', $3::json, '{"kind":"subagent"}', '{"context":[],"message":"задача"}') RETURNING id`,
      [childSession, newTurnId(), JSON.stringify(OWNER_AUTH)],
    )).rows[0]!;
    const model = routedModel(() => reply("сделал"));

    const outcome = await runTurn(testRuntime({ agent: testAgent({}), callModel: model.callModel, observer: recordingObserver().observer }), orphan.id, RUN);

    expect(outcome).toMatchObject({ code: "AGENT_SUBAGENT_CALLER_MISSING", status: "failed" });
    expect(model.requests).toHaveLength(0);
  });

  it("waits for the same child after a restart instead of starting another one", async () => {
    const sessionId = await newTestSession();
    let childCalls = 0;
    const first = routedModel((call, task) => {
      if (task !== null) { childCalls += 1; return never(); }
      return delegateTo({ id: "call-a", message: "долго" });
    });
    const turn = await startMessageTurn(sessionId, "делай");
    void runTurn(testRuntime({ agent: testAgent({ agent: agentTool }), callModel: first.callModel, observer: recordingObserver().observer }), turn.id, RUN);
    await vi.waitFor(() => expect(childCalls).toBe(1));
    await database().query("UPDATE agent_turns SET runner_id = NULL");

    const second = routedModel((call, task) => task !== null ? reply("наконец") : reply("Готово."));
    const outcome = await runTurn(testRuntime({
      agent: testAgent({ agent: agentTool }), callModel: second.callModel, observer: recordingObserver().observer, runnerId: "runner-b",
    }), turn.id, RUN);

    expect(outcome).toEqual({ status: "completed", text: "Готово." });
    expect(await childTurns()).toHaveLength(1);
    expect(second.requests.at(-1)!.messages.at(-1)).toMatchObject({ content: [{ output: { value: "наконец" } }] });
  });
});
