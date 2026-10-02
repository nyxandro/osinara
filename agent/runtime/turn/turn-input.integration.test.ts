import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { closeDatabase, database } from "../../lib/database.js";
import { loadSessionHistory } from "../history/history-repository.js";
import { defineTool } from "../tool.js";
import { loadTurn } from "./journal-repository.js";
import { runTurn } from "./run-turn.js";
import { respondToInput } from "./turn-start.js";
import {
  newTestSession, OWNER_AUTH, recordingObserver, reply, scriptedModel, startMessageTurn, testAgent, testRuntime, toolCalls,
} from "./turn.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");

const RUN = { abortSignal: new AbortController().signal };
const PENDING_NOTE = /^\[Pending approvals\]\nThe following tool calls are awaiting approval and have not executed:\n\{"requestId":"aitxt-[A-Za-z0-9]{24}","toolName":"project"\}$/;

function guardedTool(execute = vi.fn(async ({ group }: { group: string }) => ({ changed: true, group }))) {
  return { execute, tool: defineTool({
    approval: () => "user-approval" as const,
    description: "Включить проекцию",
    execute,
    inputSchema: z.object({ group: z.string() }),
  }) };
}

const askQuestion = defineTool({
  description: "Спросить",
  execute: async (): Promise<string> => { throw new Error("ask_question never executes"); },
  inputSchema: z.object({ prompt: z.string(), options: z.array(z.object({ id: z.string(), label: z.string() })).optional() }),
});

async function history(sessionId: string) {
  return (await loadSessionHistory(database(), sessionId)).messages;
}

async function respond(sessionId: string, responses: Array<{ optionId?: string; requestId: string; text?: string }>, context: string[] = []) {
  return await respondToInput(database(), { auth: OWNER_AUTH, context, responses, sessionId });
}

async function parkOnApproval(calls: Array<{ id: string; group: string }>) {
  const sessionId = await newTestSession();
  const guarded = guardedTool();
  const { events, observer } = recordingObserver();
  const turn = await startMessageTurn(sessionId, "включи");
  const outcome = await runTurn(testRuntime({
    agent: testAgent({ project: guarded.tool }),
    callModel: scriptedModel(toolCalls(calls.map((call) => ({ id: call.id, input: { group: call.group }, name: "project" })))).callModel,
    observer,
  }), turn.id, RUN);
  if (outcome.status !== "waiting_input") throw new Error(`TEST_EXPECTED_PARK: ${outcome.status}`);
  return { events, guarded, outcome, sessionId, turn };
}

async function continueWith(sessionId: string, continuationId: string, guarded: ReturnType<typeof guardedTool>, ...steps: ReturnType<typeof reply>[]) {
  const model = scriptedModel(...steps);
  const outcome = await runTurn(testRuntime({
    agent: testAgent({ project: guarded.tool }), callModel: model.callModel, observer: recordingObserver().observer,
  }), continuationId, RUN);
  return { model, outcome };
}

(enabled ? describe : describe.skip)("turns that wait for a person", () => {
  beforeEach(async () => { await database().query("TRUNCATE users, families CASCADE"); });
  afterAll(closeDatabase);

  it("parks on an approval with the pending note in history and runs the approved call once", async () => {
    const { events, guarded, outcome, sessionId, turn } = await parkOnApproval([{ id: "call-1", group: "g1" }]);

    expect(outcome.requests).toMatchObject([{ action: { callId: "call-1", toolName: "project" }, kind: "tool-approval" }]);
    expect(events.map((event) => event.kind)).toEqual(["turnStarted", "inputRequested", "turnFinished"]);
    expect(await history(sessionId)).toEqual([
      { role: "user", content: "включи" },
      { role: "user", content: expect.stringMatching(PENDING_NOTE) },
    ]);
    expect(guarded.execute).not.toHaveBeenCalled();

    const resumed = await respond(sessionId, [{ optionId: "approve", requestId: outcome.requests[0]!.requestId }]);
    if (resumed.status !== "resumed") throw new Error(resumed.status);
    const { model, outcome: final } = await continueWith(sessionId, resumed.continuation.id, guarded, reply("Включил."));

    expect(final).toEqual({ status: "completed", text: "Включил." });
    expect(guarded.execute).toHaveBeenCalledTimes(1);
    expect(model.requests[0]!.messages.slice(-2)).toEqual([
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "project", input: { group: "g1" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "project", output: { type: "json", value: { changed: true, group: "g1" } } }] },
    ]);
    expect(model.requests[0]!.toolChoice).toBeUndefined();
    expect(await loadTurn(database(), turn.id)).toMatchObject({ status: "completed" });
  });

  it("explains a denial to the model without running the tool", async () => {
    const { guarded, outcome, sessionId } = await parkOnApproval([{ id: "call-1", group: "g1" }]);

    const resumed = await respond(sessionId, [{ optionId: "cancel", requestId: outcome.requests[0]!.requestId }]);
    if (resumed.status !== "resumed") throw new Error(resumed.status);
    const { model } = await continueWith(sessionId, resumed.continuation.id, guarded, reply("Не стал."));

    expect(guarded.execute).not.toHaveBeenCalled();
    expect(model.requests[0]!.messages.at(-1)).toEqual({ role: "tool", content: [{
      type: "tool-result", toolCallId: "call-1", toolName: "project", output: { type: "execution-denied", reason: "Tool execution was denied." },
    }] });
  });

  it("puts the context of a button press before the restored approval transcript", async () => {
    const { guarded, outcome, sessionId } = await parkOnApproval([{ id: "call-1", group: "g1" }]);
    const timeout = "Пользователь не подтвердил действие «project» более 5 мин, поэтому оно не выполнено.";

    const resumed = await respond(sessionId, [{ optionId: "cancel", requestId: outcome.requests[0]!.requestId }], [timeout]);
    if (resumed.status !== "resumed") throw new Error(resumed.status);
    const { model } = await continueWith(sessionId, resumed.continuation.id, guarded, reply("Не подтвердили."));

    expect(model.requests[0]!.messages.slice(1).map((message) => message.role === "user" ? message.content : message.role)).toEqual([
      expect.stringMatching(PENDING_NOTE), timeout, "assistant", "tool",
    ]);
  });

  it("keeps the first decision of a batch while the second one waits", async () => {
    const { guarded, outcome, sessionId } = await parkOnApproval([{ id: "call-1", group: "g1" }, { id: "call-2", group: "g2" }]);
    const [first, second] = outcome.requests;

    expect(await respond(sessionId, [{ optionId: "approve", requestId: first!.requestId }])).toMatchObject({ status: "waiting" });
    const resumed = await respond(sessionId, [{ optionId: "cancel", requestId: second!.requestId }]);
    if (resumed.status !== "resumed") throw new Error(resumed.status);
    const { model } = await continueWith(sessionId, resumed.continuation.id, guarded, reply("Одну включил."));

    expect(guarded.execute).toHaveBeenCalledTimes(1);
    expect(guarded.execute.mock.calls[0]![0]).toEqual({ group: "g1" });
    expect(model.requests[0]!.messages.at(-1)).toMatchObject({ role: "tool", content: [
      { output: { type: "json" }, toolCallId: "call-1" },
      { output: { type: "execution-denied", reason: "Tool execution was denied." }, toolCallId: "call-2" },
    ] });
  });

  it("returns an answer to a request that no longer waits as stale", async () => {
    const { outcome, sessionId } = await parkOnApproval([{ id: "call-1", group: "g1" }]);
    const resumed = await respond(sessionId, [{ optionId: "approve", requestId: outcome.requests[0]!.requestId }]);

    expect(resumed.status).toBe("resumed");
    expect(await respond(sessionId, [{ optionId: "approve", requestId: outcome.requests[0]!.requestId }])).toEqual({
      stale: [{ optionId: "approve", requestId: outcome.requests[0]!.requestId }], status: "stale",
    });
  });

  it("answers other messages without tools while an approval waits", async () => {
    const { sessionId } = await parkOnApproval([{ id: "call-1", group: "g1" }]);
    const turn = await startMessageTurn(sessionId, "а пока скажи время");
    const model = scriptedModel(reply("12:00"));

    await runTurn(testRuntime({ agent: testAgent({}), callModel: model.callModel, observer: recordingObserver().observer }), turn.id, RUN);

    expect(model.requests[0]!.toolChoice).toBe("none");
  });

  it("feeds the answer to a question back as its tool result", async () => {
    const sessionId = await newTestSession();
    const turn = await startMessageTurn(sessionId, "спроси");
    const parked = await runTurn(testRuntime({
      agent: testAgent({ ask_question: askQuestion }),
      callModel: scriptedModel(toolCalls([{ id: "call-q", input: { options: [{ id: "continue", label: "Продолжить" }], prompt: "Дальше?" }, name: "ask_question" }])).callModel,
      observer: recordingObserver().observer,
    }), turn.id, RUN);
    expect(parked).toMatchObject({ requests: [{ display: "select", kind: "question", prompt: "Дальше?", requestId: "call-q" }], status: "waiting_input" });
    expect(await history(sessionId)).toEqual([{ role: "user", content: "спроси" }]);

    const resumed = await respond(sessionId, [{ optionId: "continue", requestId: "call-q" }]);
    if (resumed.status !== "resumed") throw new Error(resumed.status);
    const model = scriptedModel(reply("Продолжаю."));
    await runTurn(testRuntime({ agent: testAgent({ ask_question: askQuestion }), callModel: model.callModel, observer: recordingObserver().observer }), resumed.continuation.id, RUN);

    expect(model.requests[0]!.messages.at(-1)).toEqual({ role: "tool", content: [{
      type: "tool-result", toolCallId: "call-q", toolName: "ask_question", output: { type: "json", value: { optionId: "continue", status: "answered" } },
    }] });
  });

  it("dismisses a waiting question when a new message arrives, before that message", async () => {
    const sessionId = await newTestSession();
    const turn = await startMessageTurn(sessionId, "спроси");
    await runTurn(testRuntime({
      agent: testAgent({ ask_question: askQuestion }),
      callModel: scriptedModel(toolCalls([{ id: "call-q", input: { prompt: "Дальше?" }, name: "ask_question" }])).callModel,
      observer: recordingObserver().observer,
    }), turn.id, RUN);

    const next = await startMessageTurn(sessionId, "забудь, другое", ["<telegram_context/>"]);
    const model = scriptedModel(reply("Хорошо."));
    await runTurn(testRuntime({ agent: testAgent({ ask_question: askQuestion }), callModel: model.callModel, observer: recordingObserver().observer }), next.id, RUN);

    expect(model.requests[0]!.messages).toEqual([
      { role: "user", content: "спроси" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-q", toolName: "ask_question", input: { prompt: "Дальше?" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-q", toolName: "ask_question", output: { type: "json", value: { status: "ignored" } } }] },
      { role: "user", content: "<telegram_context/>" },
      { role: "user", content: "забудь, другое" },
    ]);
    expect(await loadTurn(database(), turn.id)).toMatchObject({ status: "completed" });
  });

  it("fails the turn when its request cannot be shown to the person", async () => {
    const sessionId = await newTestSession();
    const guarded = guardedTool();
    const turn = await startMessageTurn(sessionId, "включи");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await runTurn(testRuntime({
      agent: testAgent({ project: guarded.tool }),
      callModel: scriptedModel(toolCalls([{ id: "call-1", input: { group: "g" }, name: "project" }])).callModel,
      observer: recordingObserver({ inputRequested: async () => { throw new Error("telegram down"); } }).observer,
    }), turn.id, RUN);

    expect(outcome).toMatchObject({ code: "AGENT_TURN_FAILED", status: "failed" });
    expect(await loadTurn(database(), turn.id)).toMatchObject({ status: "failed" });
    vi.restoreAllMocks();
  });
});
