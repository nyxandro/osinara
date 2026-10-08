import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AppError } from "../../lib/app-error.js";
import { closeDatabase, database } from "../../lib/database.js";
import { loadSessionHistory } from "../history/history-repository.js";
import { defineTool } from "../tool.js";
import { estimateTokens } from "./compaction-estimate.js";
import { loadTurn } from "./journal-repository.js";
import { EmptyModelResponseError } from "./model-errors.js";
import { runTurn, type TurnRuntime } from "./run-turn.js";
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

// A sandbox whose home is "/", as on the reference bench, that records skill syncs.
function skillSandbox() {
  const syncs: Array<{ packages: Array<{ files: string[]; name: string }>; removed: string[] }> = [];
  const sandbox = {
    async run() { return { exitCode: 0, stderr: "", stdout: "/\n" }; },
    async syncSkills(packages: ReadonlyArray<{ files: ReadonlyArray<{ relativePath: string }>; name: string }>, removed: readonly string[]) {
      syncs.push({ packages: packages.map((pkg) => ({ files: pkg.files.map((file) => file.relativePath), name: pkg.name })), removed: [...removed] });
    },
  } as never;
  return { sandbox, syncs };
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

  it("tells the application before every model call which turn is about to call the model", async () => {
    const sessionId = await newTestSession();
    const started: Array<{ session: string; turn: string }> = [];
    const echo = defineTool({ description: "echo", inputSchema: z.object({}), async execute() { return "ok"; } });
    let calls = 0;
    const agent = testAgent({ echo }, {
      stepStarted: async (ctx) => { started.push({ session: ctx.session.id, turn: ctx.session.turn.id }); },
    });
    const turn = await startMessageTurn(sessionId, "привет");

    await runTurn(testRuntime({
      agent,
      callModel: async () => (calls += 1) === 1 ? toolCalls([{ id: "call-1", input: {}, name: "echo" }]) : reply("Готово."),
      observer: recordingObserver().observer,
    }), turn.id, RUN);

    expect(started).toEqual([{ session: sessionId, turn: turn.id }, { session: sessionId, turn: turn.id }]);
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

  it("shows the model a broken tool input as the reference error", async () => {
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
    const stepStarted = vi.fn(async () => {});
    const outcome = await runTurn(testRuntime({
      agent: testAgent({ note: noteTool(note) }, { stepStarted }), callModel: second.callModel, observer: recordingObserver().observer, runnerId: "runner-b",
    }), turn.id, RUN);

    expect(outcome).toEqual({ status: "completed", text: "готово" });
    expect(note).toHaveBeenCalledTimes(1);
    expect(second.requests).toHaveLength(1);
    // Only the new model call of the recovered turn starts a step; the recorded one is not redone.
    expect(stepStarted).toHaveBeenCalledTimes(1);
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

    const outcome = await runTurn(testRuntime({ agent: testAgent({}), callModel: scriptedModel(reply("<empty-delivery/>")).callModel, observer }), turn.id, RUN);

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
      resolveSkills: async () => ({ pohuy: { description: "Режим", markdown: "---\nname: pohuy\n---\nтекст" } }),
    });
    const turn = await startMessageTurn(sessionId, "привет");

    await runTurn({ ...testRuntime({ agent, callModel: model.callModel, observer: recordingObserver().observer }), sandbox: async () => skillSandbox().sandbox }, turn.id, RUN);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]![0]).toMatchObject({ messages: [{ role: "user", content: "привет" }], turnId: turn.id });
    for (const request of model.requests) {
      expect(request.system).toMatch(/^Instructions \(instructions\)\nправила\n\n<osinara_turn_memory>…<\/osinara_turn_memory>\n\nAvailable skills\n/);
      expect(request.system).toContain("- pohuy: Режим (path: /.agents/skills/pohuy/SKILL.md)");
    }
    expect((await history(sessionId)).slice(0, 2)).toEqual([{ role: "user", content: "<reaction_set/>" }, { role: "user", content: "привет" }]);
  });

  it("syncs the turn's skills into the sandbox in one batch and removes the ones no longer granted", async () => {
    const sessionId = await newTestSession();
    const { sandbox, syncs } = skillSandbox();
    let granted: Record<string, { description: string; files?: Record<string, string>; markdown: string }> = {
      digest: { description: "Сводка", files: { "references/b.md": "b", "references/a.md": "a" }, markdown: "# digest" },
    };
    const agent = testAgent({}, { resolveSkills: async () => granted });
    const run = async (text: string) => {
      const turn = await startMessageTurn(sessionId, text);
      await runTurn({ ...testRuntime({ agent, callModel: scriptedModel(reply("ok")).callModel, observer: recordingObserver().observer }), sandbox: async () => sandbox }, turn.id, RUN);
    };

    await run("первый");
    granted = {};
    await run("второй");
    await run("третий");

    expect(syncs).toEqual([
      { packages: [{ files: ["SKILL.md", "references/a.md", "references/b.md"], name: "digest" }], removed: [] },
      { packages: [], removed: ["digest"] },
    ]);
  });

  it("compacts a long history before the step and keeps the turn input once", async () => {
    const long = Array.from({ length: 12 }, (_, index) => [
      { role: "user" as const, content: `вопрос ${index} ${"x".repeat(1_200)}` },
      { role: "assistant" as const, content: [{ type: "text" as const, text: `ответ ${index} ${"y".repeat(1_200)}` }] },
    ]).flat();
    const sessionId = await newTestSession(long);
    await database().query("UPDATE agent_session_state SET todo = $2::json WHERE session_id = $1",
      [sessionId, JSON.stringify({ items: [{ content: "доделать", priority: "high", status: "pending" }] })]);
    const summarize = vi.fn<TurnRuntime["summarize"]>(async () => "Сводка разговора");
    const model = scriptedModel(reply("Отвечаю."));
    const turn = await startMessageTurn(sessionId, "новый вопрос");

    await runTurn(testRuntime({
      agent: testAgent({}, { selectModel: () => ({ contextWindowTokens: 8_000, model: "test-model-unused", providerOptions: undefined }) }),
      callModel: model.callModel, observer: recordingObserver().observer, summarize,
    }), turn.id, RUN);

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0]![0]).toMatchObject({ providerOptions: undefined });
    const sent = model.requests[0]!.messages;
    expect(sent.slice(0, 2)).toEqual([
      { role: "user", content: "Summary of our conversation so far:" },
      { role: "assistant", content: "Сводка разговора" },
    ]);
    expect(sent.filter((message) => message.content === "новый вопрос")).toHaveLength(1);
    expect(sent.at(-1)).toEqual({ role: "user", content: "[Your task list was preserved across context compaction]\n- [ ] [high] доделать" });
    const stored = await loadSessionHistory(database(), sessionId);
    expect(stored.generation).toBe(1);
    expect(stored.messages).toEqual([...sent, { role: "assistant", content: [{ type: "text", text: "Отвечаю." }] }]);
  });

  // Production, 5 October 2026: a group chat whose prompt the provider had measured past the
  // threshold was re-saved uncompressed at every step until the model refused it.
  it("summarizes a history the provider measured over the threshold even when capping changes nothing", async () => {
    const long = Array.from({ length: 10 }, (_, index) => [
      { role: "user" as const, content: `question ${index} ${"x".repeat(1_000)}` },
      { role: "assistant" as const, content: [{ type: "text" as const, text: `answer ${index} ${"y".repeat(1_000)}` }] },
    ]).flat();
    const sessionId = await newTestSession(long);
    await database().query(
      "UPDATE agent_session_state SET compaction_input_tokens = $2, compaction_prompt_message_count = $3 WHERE session_id = $1",
      [sessionId, Math.round(estimateTokens(long)) + 1_500, long.length],
    );
    const summarize = vi.fn<TurnRuntime["summarize"]>(async () => "Сводка разговора");
    const model = scriptedModel(reply("Отвечаю."));
    const turn = await startMessageTurn(sessionId, "новый вопрос");

    await runTurn(testRuntime({
      agent: testAgent({}, { selectModel: () => ({ contextWindowTokens: 8_000, model: "test-model-unused", providerOptions: undefined }) }),
      callModel: model.callModel, observer: recordingObserver().observer, summarize,
    }), turn.id, RUN);

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(model.requests[0]!.messages.slice(0, 2)).toEqual([
      { role: "user", content: "Summary of our conversation so far:" },
      { role: "assistant", content: "Сводка разговора" },
    ]);
  });

  // #331: the model refusing the summary request itself used to stop the chat for good — every
  // next message sent the same request over the same history and got the same refusal.
  it("remembers a refused summary, and the next message asks to summarize less", async () => {
    const long = Array.from({ length: 12 }, (_, index) => [
      { role: "user" as const, content: `вопрос ${index} ${"x".repeat(1_200)}` },
      { role: "assistant" as const, content: [{ type: "text" as const, text: `ответ ${index} ${"y".repeat(1_200)}` }] },
    ]).flat();
    const sessionId = await newTestSession(long);
    const runtimeWith = (summarize: TurnRuntime["summarize"], model: ReturnType<typeof scriptedModel>) => testRuntime({
      agent: testAgent({}, { selectModel: () => ({ contextWindowTokens: 8_000, model: "test-model-unused", providerOptions: undefined }) }),
      callModel: model.callModel, observer: recordingObserver().observer, summarize,
    });
    const refusals = async () => (await database().query<{ count: number }>(
      "SELECT compaction_summary_refusals AS count FROM agent_session_state WHERE session_id = $1", [sessionId],
    )).rows[0]!.count;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const transient = await runTurn(runtimeWith(async () => {
      throw Object.assign(new Error("provider unavailable"), { isRetryable: true });
    }, scriptedModel()), (await startMessageTurn(sessionId, "первый")).id, RUN);
    expect(transient).toMatchObject({ code: "AGENT_MODEL_TEMPORARILY_UNAVAILABLE", status: "failed" });
    expect(await refusals()).toBe(0);

    // A broken key fails every request; it is not this summary being turned down.
    const brokenKey = await runTurn(runtimeWith(async () => {
      throw Object.assign(new Error("invalid api key"), { statusCode: 401 });
    }, scriptedModel()), (await startMessageTurn(sessionId, "ключ")).id, RUN);
    expect(brokenKey).toMatchObject({ code: "AGENT_MODEL_CALL_FAILED", status: "failed" });
    expect(await refusals()).toBe(0);

    const refused = await runTurn(runtimeWith(async () => {
      throw new Error("refused: input is too long for this model");
    }, scriptedModel()), (await startMessageTurn(sessionId, "второй")).id, RUN);
    // The person is told the next message helps, not that repeating cannot.
    expect(refused).toMatchObject({ code: "AGENT_COMPACTION_SUMMARY_REFUSED", status: "failed" });
    expect(await refusals()).toBe(1);
    expect(warn.mock.calls.map((call) => JSON.parse(call[0] as string))).toContainEqual(
      expect.objectContaining({ code: "AGENT_COMPACTION_SUMMARY_REFUSED", refusals: 1, sessionId }),
    );

    const summarize = vi.fn<TurnRuntime["summarize"]>(async () => "Сводка разговора");
    const answered = await runTurn(runtimeWith(summarize, scriptedModel(reply("Отвечаю."))),
      (await startMessageTurn(sessionId, "третий")).id, RUN);
    expect(answered).toMatchObject({ status: "completed" });
    expect(summarize.mock.calls[0]![0].prompt).toContain("earlier messages omitted");
    expect(await refusals()).toBe(0);
    vi.restoreAllMocks();
  });

  it("counts the step's tool definitions before the provider has measured the history", async () => {
    const long = Array.from({ length: 8 }, (_, index) => [
      { role: "user" as const, content: `question ${index} ${"x".repeat(1_000)}` },
      { role: "assistant" as const, content: [{ type: "text" as const, text: `answer ${index} ${"y".repeat(1_000)}` }] },
    ]).flat();
    const sessionId = await newTestSession(long);
    const summarize = vi.fn<TurnRuntime["summarize"]>(async () => "Сводка разговора");
    const model = scriptedModel(reply("Отвечаю."));
    const turn = await startMessageTurn(sessionId, "новый вопрос");
    const selectModel = () => ({ contextWindowTokens: 8_000, model: "test-model-unused", providerOptions: undefined });

    // The history alone fits; with a tool whose definition is 8 000 bytes the request does not.
    await runTurn(testRuntime({
      agent: testAgent({ note: noteTool(undefined, { description: "d".repeat(8_000) }) }, { selectModel }),
      callModel: model.callModel, observer: recordingObserver().observer, summarize,
    }), turn.id, RUN);

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(model.requests[0]!.messages[0]).toEqual({ role: "user", content: "Summary of our conversation so far:" });
  });
});
