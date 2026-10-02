import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AppError } from "../../lib/app-error.js";
import { closeDatabase, database } from "../../lib/database.js";
import { loadSessionHistory } from "../history/history-repository.js";
import { defineTool } from "../tool.js";
import { loadTurn } from "./journal-repository.js";
import { EmptyModelResponseError } from "./model-errors.js";
import { runTurn } from "./run-turn.js";
import {
  newTestSession, recordingObserver, reply, scriptedModel, startMessageTurn, testAgent, testRuntime, toolCalls,
} from "./turn.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");

const RUN = { abortSignal: new AbortController().signal };

function noteTool(execute: (input: { text: string }) => Promise<unknown> | unknown = ({ text }) => `noted:${text}`, extra = {}) {
  return defineTool({ description: "Записать заметку", inputSchema: z.object({ text: z.string() }), execute, ...extra });
}

async function history(sessionId: string) {
  return (await loadSessionHistory(database(), sessionId)).messages;
}

// A process that dies mid-turn: the promise never settles and the turn keeps its runner.
const never = <T>() => new Promise<T>(() => {});

async function releaseRunner(turnId: string) {
  await database().query("UPDATE agent_turns SET runner_id = NULL WHERE id = $1", [turnId]);
}

(enabled ? describe : describe.skip)("turn loop", () => {
  beforeEach(async () => { await database().query("TRUNCATE users, families CASCADE"); });
  afterAll(closeDatabase);

  it("answers a message and writes the exchange into history", async () => {
    const sessionId = await newTestSession([{ role: "user", content: "раньше" }, { role: "assistant", content: [{ type: "text", text: "давно" }] }]);
    const model = scriptedModel(reply("привет!"));
    const { events, observer } = recordingObserver();
    const turn = await startMessageTurn(sessionId, "привет", ["<telegram_context>…</telegram_context>"]);

    const outcome = await runTurn(testRuntime({ agent: testAgent({}), callModel: model.callModel, observer }), turn.id, RUN);

    expect(outcome).toEqual({ status: "completed", text: "привет!" });
    expect(model.requests[0]).toMatchObject({
      messages: [
        { role: "user", content: "раньше" },
        { role: "assistant", content: [{ type: "text", text: "давно" }] },
        { role: "user", content: "<telegram_context>…</telegram_context>" },
        { role: "user", content: "привет" },
      ],
      providerOptions: { neuraldeep: { user: sessionId } },
      system: "Instructions (instructions)\nправила",
    });
    expect((await history(sessionId)).slice(2)).toEqual([
      { role: "user", content: "<telegram_context>…</telegram_context>" },
      { role: "user", content: "привет" },
      { role: "assistant", content: [{ type: "text", text: "привет!" }] },
    ]);
    expect(events.map((event) => event.kind)).toEqual(["turnStarted", "stepText", "turnFinished"]);
    expect(events[1]).toMatchObject({ finishReason: "stop", message: "привет!", stepIndex: 0 });
    expect(await loadTurn(database(), turn.id)).toMatchObject({ finalText: "привет!", runnerId: null, status: "completed" });
  });

  it("runs the step's tools once, concurrently, and continues with their results", async () => {
    const sessionId = await newTestSession();
    const executed: string[] = [];
    let release!: () => void;
    const both = new Promise<void>((done) => { release = done; });
    const note = noteTool(async ({ text }) => {
      executed.push(text);
      if (executed.length === 2) release();
      await both;
      return `noted:${text}`;
    });
    const model = scriptedModel(
      toolCalls([{ id: "call-1", input: { text: "a" }, name: "note" }, { id: "call-2", input: { text: "b" }, name: "note" }], "Сейчас запишу."),
      reply("Записал обе."),
    );
    const { events, observer } = recordingObserver();
    const turn = await startMessageTurn(sessionId, "запиши");

    const outcome = await runTurn(testRuntime({ agent: testAgent({ note }), callModel: model.callModel, observer }), turn.id, RUN);

    expect(outcome).toEqual({ status: "completed", text: "Записал обе." });
    expect(executed.sort()).toEqual(["a", "b"]);
    expect(model.requests[1]!.messages.slice(-2)).toEqual([
      { role: "assistant", content: [
        { type: "text", text: "Сейчас запишу." },
        { type: "tool-call", toolCallId: "call-1", toolName: "note", input: { text: "a" } },
        { type: "tool-call", toolCallId: "call-2", toolName: "note", input: { text: "b" } },
      ] },
      { role: "tool", content: [
        { type: "tool-result", toolCallId: "call-1", toolName: "note", output: { type: "text", value: "noted:a" } },
        { type: "tool-result", toolCallId: "call-2", toolName: "note", output: { type: "text", value: "noted:b" } },
      ] },
    ]);
    expect(events.filter((event) => event.kind === "stepText")).toMatchObject([
      { finishReason: "tool-calls", message: "Сейчас запишу.", stepIndex: 0 },
      { finishReason: "stop", message: "Записал обе.", stepIndex: 1 },
    ]);
    expect(events).toContainEqual({ calls: ["call-1", "call-2"], kind: "toolsStarted", turnId: turn.id });
    expect(await history(sessionId)).toHaveLength(4);
  });

  it("shows the model a broken tool input as the error Eve reported", async () => {
    const sessionId = await newTestSession();
    const model = scriptedModel(
      { ...toolCalls([{ id: "call-1", input: {}, name: "note" }]), toolCalls: [{ input: "[1]", toolCallId: "call-1", toolName: "note" }] },
      reply("ок"),
    );
    const turn = await startMessageTurn(sessionId, "запиши");

    await runTurn(testRuntime({ agent: testAgent({ note: noteTool() }), callModel: model.callModel, observer: recordingObserver().observer }), turn.id, RUN);

    expect(model.requests[1]!.messages.at(-1)).toEqual({ role: "tool", content: [{
      type: "tool-result", toolCallId: "call-1", toolName: "note",
      output: { type: "error-text", value: 'Failed to parse tool-call arguments for "note" (call-1): Expected a JSON-serializable object.' },
    }] });
  });

  it("does not ask the model again for a step recorded before a crash", async () => {
    const sessionId = await newTestSession();
    const note = vi.fn(async ({ text }: { text: string }) => `noted:${text}`);
    const first = scriptedModel(toolCalls([{ id: "call-1", input: { text: "a" }, name: "note" }]), () => never());
    const turn = await startMessageTurn(sessionId, "запиши");
    void runTurn(testRuntime({ agent: testAgent({ note: noteTool(note) }), callModel: first.callModel, observer: recordingObserver().observer }), turn.id, RUN);
    await vi.waitFor(() => expect(first.requests).toHaveLength(2));
    await releaseRunner(turn.id);

    const second = scriptedModel(reply("готово"));
    const outcome = await runTurn(testRuntime({
      agent: testAgent({ note: noteTool(note) }), callModel: second.callModel, observer: recordingObserver().observer, runnerId: "runner-b",
    }), turn.id, RUN);

    expect(outcome).toEqual({ status: "completed", text: "готово" });
    expect(note).toHaveBeenCalledTimes(1);
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0]!.messages).toHaveLength(3);
  });

  it("reports an interrupted action as an unknown outcome instead of repeating it", async () => {
    const sessionId = await newTestSession();
    const send = vi.fn(() => never<string>());
    const turn = await startMessageTurn(sessionId, "отправь");
    const first = scriptedModel(toolCalls([{ id: "call-1", input: { text: "письмо" }, name: "send" }]));
    void runTurn(testRuntime({ agent: testAgent({ send: noteTool(send) }), callModel: first.callModel, observer: recordingObserver().observer }), turn.id, RUN);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await releaseRunner(turn.id);

    const second = scriptedModel(reply("Не знаю, ушло ли письмо."));
    await runTurn(testRuntime({
      agent: testAgent({ send: noteTool(send) }), callModel: second.callModel, observer: recordingObserver().observer, runnerId: "runner-b",
    }), turn.id, RUN);

    expect(send).toHaveBeenCalledTimes(1);
    expect(second.requests[0]!.messages.at(-1)).toMatchObject({ role: "tool", content: [{
      output: { type: "error-text", value: expect.stringMatching(/^AGENT_TOOL_OUTCOME_UNKNOWN: /) }, toolCallId: "call-1",
    }] });
  });

  it("repeats an interrupted replay-safe call after a crash", async () => {
    const sessionId = await newTestSession();
    let runs = 0;
    const read = noteTool(async ({ text }) => { runs += 1; return runs === 1 ? never() : `read:${text}`; }, { replaySafe: true });
    const turn = await startMessageTurn(sessionId, "прочитай");
    void runTurn(testRuntime({
      agent: testAgent({ read }), callModel: scriptedModel(toolCalls([{ id: "call-1", input: { text: "x" }, name: "read" }])).callModel,
      observer: recordingObserver().observer,
    }), turn.id, RUN);
    await vi.waitFor(() => expect(runs).toBe(1));
    await releaseRunner(turn.id);

    const second = scriptedModel(reply("прочитал"));
    await runTurn(testRuntime({ agent: testAgent({ read }), callModel: second.callModel, observer: recordingObserver().observer, runnerId: "runner-b" }), turn.id, RUN);

    expect(runs).toBe(2);
    expect(second.requests[0]!.messages.at(-1)).toMatchObject({ content: [{ output: { type: "text", value: "read:x" } }] });
  });

  it("does not take a turn another live process is running", async () => {
    const sessionId = await newTestSession();
    const turn = await startMessageTurn(sessionId, "привет");
    void runTurn(testRuntime({ agent: testAgent({}), callModel: () => never(), observer: recordingObserver().observer }), turn.id, RUN);
    await vi.waitFor(async () => expect((await loadTurn(database(), turn.id)).runnerId).toBe("runner-a"));

    const outcome = await runTurn(testRuntime({
      agent: testAgent({}), callModel: scriptedModel(reply("x")).callModel, observer: recordingObserver().observer, runnerId: "runner-b",
    }), turn.id, RUN);

    expect(outcome).toEqual({ status: "busy" });
  });

  it("stops at the step limit with Osinara's code, without another model call", async () => {
    const sessionId = await newTestSession();
    const loop = toolCalls([{ id: "call-x", input: { text: "a" }, name: "note" }]);
    const model = scriptedModel(loop, { ...loop, toolCalls: [{ input: { text: "b" }, toolCallId: "call-y", toolName: "note" }],
      messages: [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "call-y", toolName: "note", input: { text: "b" } }] }] });
    const turn = await startMessageTurn(sessionId, "крутись");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await runTurn(testRuntime({
      agent: testAgent({ note: noteTool() }, { maxModelSteps: 2 }), callModel: model.callModel, observer: recordingObserver().observer,
    }), turn.id, RUN);

    expect(outcome).toMatchObject({ code: "AGENT_TURN_MODEL_STEP_LIMIT_EXCEEDED", status: "failed" });
    expect(model.requests).toHaveLength(2);
    expect(await history(sessionId)).toHaveLength(5);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ code: "AGENT_TURN_FAILED", errorCode: "AGENT_TURN_MODEL_STEP_LIMIT_EXCEEDED" });
    log.mockRestore();
  });

  it("fails an empty model answer with a coded error and keeps history as it was", async () => {
    const sessionId = await newTestSession();
    const turn = await startMessageTurn(sessionId, "привет");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await runTurn(testRuntime({
      agent: testAgent({}), callModel: async () => { throw new EmptyModelResponseError(); }, observer: recordingObserver().observer,
    }), turn.id, RUN);

    expect(outcome).toMatchObject({ code: "AGENT_MODEL_OUTPUT_INCOMPLETE", status: "failed" });
    expect(await history(sessionId)).toEqual([]);
    vi.restoreAllMocks();
  });

  it("delivers nothing for the empty-delivery marker and keeps the reply out of history", async () => {
    const sessionId = await newTestSession();
    const { events, observer } = recordingObserver();
    const turn = await startMessageTurn(sessionId, "что нового?");

    const outcome = await runTurn(testRuntime({ agent: testAgent({}), callModel: scriptedModel(reply("<eve-empty-delivery/>")).callModel, observer }), turn.id, RUN);

    expect(outcome).toEqual({ status: "completed", text: null });
    expect(events.find((event) => event.kind === "stepText")).toMatchObject({ message: null });
    expect(await history(sessionId)).toEqual([{ role: "user", content: "что нового?" }]);
  });

  it("cancels the turn without writing its unfinished step", async () => {
    const sessionId = await newTestSession();
    const cancel = new AbortController();
    const slow = noteTool(async () => { cancel.abort(new Error("steered")); throw new Error("aborted"); });
    const turn = await startMessageTurn(sessionId, "делай");

    const outcome = await runTurn(testRuntime({
      agent: testAgent({ slow }), callModel: scriptedModel(toolCalls([{ id: "call-1", input: { text: "a" }, name: "slow" }])).callModel,
      observer: recordingObserver().observer,
    }), turn.id, { abortSignal: cancel.signal });

    expect(outcome).toEqual({ status: "cancelled" });
    expect(await history(sessionId)).toEqual([]);
    expect(await loadTurn(database(), turn.id)).toMatchObject({ status: "cancelled" });
  });

  it("stops before the model when the turn cannot be prepared", async () => {
    const sessionId = await newTestSession();
    const model = scriptedModel(reply("x"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = { name: "retrieved-memory", resolve: () => { throw new Error("memory down"); } };
    const started = await startMessageTurn(sessionId, "привет");
    const turnStartFailure = await startMessageTurn(await newTestSession(), "привет");

    const byResolver = await runTurn(testRuntime({
      agent: testAgent({}, { instructionResolvers: [failing] }), callModel: model.callModel, observer: recordingObserver().observer,
    }), started.id, RUN);
    const byObserver = await runTurn(testRuntime({
      agent: testAgent({}), callModel: model.callModel,
      observer: recordingObserver({ turnStarted: async () => { throw new AppError("AGENT_MEMORY_SOURCE_BIND_FAILED", "Не удалось подготовить ход"); } }).observer,
    }), turnStartFailure.id, RUN);

    expect(byResolver).toMatchObject({ code: "AGENT_TURN_INSTRUCTIONS_FAILED", status: "failed" });
    expect(byObserver).toMatchObject({ code: "AGENT_MEMORY_SOURCE_BIND_FAILED", message: "Не удалось подготовить ход", status: "failed" });
    expect(model.requests).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it("passes the turn's system blocks and skills to every step", async () => {
    const sessionId = await newTestSession();
    const model = scriptedModel(toolCalls([{ id: "call-1", input: { text: "a" }, name: "note" }]), reply("ok"));
    const resolve = vi.fn((_context: unknown) => ({ content: "<osinara_turn_memory>…</osinara_turn_memory>", role: "system" as const }));
    const agent = testAgent({ note: noteTool() }, {
      instructionResolvers: [{ name: "memory", resolve }, { name: "reactions", resolve: () => ({ content: "<reaction_set/>", role: "user" }) }],
      resolveSkills: async () => ({ skillRoot: "/.agents/skills", skills: [{ description: "Режим", name: "pohuy" }] }),
    });
    const turn = await startMessageTurn(sessionId, "привет");

    await runTurn(testRuntime({ agent, callModel: model.callModel, observer: recordingObserver().observer }), turn.id, RUN);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]![0]).toMatchObject({ messages: [{ role: "user", content: "привет" }], turnId: turn.id });
    for (const request of model.requests) {
      expect(request.system).toMatch(/^Instructions \(instructions\)\nправила\n\n<osinara_turn_memory>…<\/osinara_turn_memory>\n\nAvailable skills\n/);
    }
    expect((await history(sessionId)).slice(0, 2)).toEqual([{ role: "user", content: "<reaction_set/>" }, { role: "user", content: "привет" }]);
  });
});
