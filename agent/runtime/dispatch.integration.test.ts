import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { closeDatabase, database } from "../lib/database.js";
import { loadSessionHistory } from "./history/history-repository.js";
import { newTurnId } from "./ids.js";
import { defineTool } from "./tool.js";
import { createTurnDispatcher } from "./dispatch.js";
import { claimTurn, loadTurn } from "./turn/journal-repository.js";
import { respondToInput } from "./turn/turn-start.js";
import {
  HELD_RUNNER_LOCK, newTestSession, OWNER_AUTH, recordingObserver, reply, scriptedModel, startMessageTurn, testAgent, testRuntime, toolCalls,
} from "./turn/turn.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");

const ADMIT_ALWAYS = async <T>(work: () => Promise<T>) => await work();
// A handler that never returns: the process died while it ran.
const DIES_HERE = () => new Promise<void>(() => {});

const approvalTools = () => ({
  change: defineTool({ description: "Изменить", inputSchema: z.object({}), approval: () => "user-approval", execute: async () => "ok" }),
});

async function until(probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await probe()) {
    if (Date.now() > deadline) throw new Error("TEST_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function untilStatus(turnId: string, status: string): Promise<void> {
  await until(async () => (await loadTurn(database(), turnId)).status === status);
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

(enabled ? describe : describe.skip)("turn dispatcher", () => {
  beforeEach(async () => { await database().query("TRUNCATE users, families CASCADE"); });
  afterAll(closeDatabase);

  it("runs a later turn of a session only after the earlier one ended, on the history it left", async () => {
    const sessionId = await newTestSession();
    const release = gate();
    const model = scriptedModel(async () => { await release.opened; return reply("первый"); }, reply("второй"));
    const { observer } = recordingObserver();
    const dispatcher = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: HELD_RUNNER_LOCK, runtime: testRuntime({ agent: testAgent({}), callModel: model.callModel, observer }), waitMilliseconds: 50,
    });
    const first = await startMessageTurn(sessionId, "раз");
    const second = await startMessageTurn(sessionId, "два");

    const firstRun = dispatcher.run(first.id);
    const secondRun = dispatcher.run(second.id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(model.requests).toHaveLength(1);
    release.open();

    expect(await firstRun).toEqual({ status: "completed", text: "первый" });
    expect(await secondRun).toEqual({ status: "completed", text: "второй" });
    expect(model.requests[1]!.messages).toEqual([
      { role: "user", content: "раз" },
      { role: "assistant", content: [{ type: "text", text: "первый" }] },
      { role: "user", content: "два" },
    ]);
  });

  it("joins a turn this process already runs instead of running it twice", async () => {
    const sessionId = await newTestSession();
    const model = scriptedModel(reply("один раз"));
    const { events, observer } = recordingObserver();
    const dispatcher = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: HELD_RUNNER_LOCK, runtime: testRuntime({ agent: testAgent({}), callModel: model.callModel, observer }), waitMilliseconds: 50,
    });
    const turn = await startMessageTurn(sessionId, "привет");

    const outcomes = await Promise.all([dispatcher.run(turn.id), dispatcher.run(turn.id)]);

    expect(outcomes).toEqual([{ status: "completed", text: "один раз" }, { status: "completed", text: "один раз" }]);
    expect(model.requests).toHaveLength(1);
    expect(events.filter((event) => event.kind === "turnFinished")).toHaveLength(1);
  });

  it("returns the stored outcome of a turn that already ended, including the requests it waits on", async () => {
    const sessionId = await newTestSession();
    const tools = {
      change: defineTool({ description: "Изменить", inputSchema: z.object({}), approval: () => "user-approval", execute: async () => "ok" }),
    };
    const model = scriptedModel(toolCalls([{ id: "call-1", input: {}, name: "change" }]));
    const { observer } = recordingObserver();
    const dispatcher = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: HELD_RUNNER_LOCK, runtime: testRuntime({ agent: testAgent(tools), callModel: model.callModel, observer }), waitMilliseconds: 50,
    });
    const turn = await startMessageTurn(sessionId, "измени");
    const first = await dispatcher.run(turn.id);

    const again = await dispatcher.run(turn.id);

    expect(first).toMatchObject({ requests: [{ kind: "tool-approval" }], status: "waiting_input" });
    expect(again).toEqual(first);
    expect(model.requests).toHaveLength(1);
  });

  it("resumes at startup the root turns another process left running, and leaves their children to the parent", async () => {
    const sessionId = await newTestSession();
    const childSessionId = await newTestSession([], { parentSessionId: sessionId });
    const answeredChildSessionId = await newTestSession([], { parentSessionId: sessionId });
    const turn = await startMessageTurn(sessionId, "продолжи");
    await claimTurn(database(), turn.id, "runner-dead");
    const child = await database().query<{ id: string }>(
      `INSERT INTO agent_turns (id, session_id, sequence, kind, status, parent_turn_id, parent_call_id, runner_id, auth, channel, input)
       VALUES ($3, $1, 0, 'subagent', 'running', $2, 'call-x', 'runner-dead', '{}', '{"kind":"subagent"}', '{"context":[]}')
       RETURNING id`,
      [childSessionId, turn.id, newTurnId()],
    );
    // A child that waited for a button continues in a turn of its own, which records no parent.
    const answered = await database().query<{ id: string }>(
      `INSERT INTO agent_turns (id, session_id, sequence, kind, status, parent_turn_id, parent_call_id, auth, channel, input, completed_at)
       VALUES ($3, $1, 0, 'subagent', 'completed', $2, 'call-y', '{}', '{"kind":"subagent"}', '{"context":[]}', now())
       RETURNING id`,
      [answeredChildSessionId, turn.id, newTurnId()],
    );
    const continuation = await database().query<{ id: string }>(
      `INSERT INTO agent_turns (id, session_id, sequence, kind, status, resumes_turn_id, runner_id, auth, channel, input)
       VALUES ($3, $1, 1, 'subagent', 'running', $2, 'runner-dead', '{}', '{"kind":"subagent"}', '{"context":[]}')
       RETURNING id`,
      [answeredChildSessionId, answered.rows[0]!.id, newTurnId()],
    );
    const model = scriptedModel(reply("доделал"));
    const { observer } = recordingObserver();
    const dispatcher = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: HELD_RUNNER_LOCK, runtime: testRuntime({ agent: testAgent({}), callModel: model.callModel, observer, runnerId: "runner-new" }), waitMilliseconds: 50,
    });

    expect(await dispatcher.recover()).toBe(1);
    await dispatcher.idle();

    expect(await loadTurn(database(), turn.id)).toMatchObject({ finalText: "доделал", status: "completed" });
    expect(await loadTurn(database(), child.rows[0]!.id)).toMatchObject({ runnerId: null, status: "running" });
    expect(await loadTurn(database(), continuation.rows[0]!.id)).toMatchObject({ runnerId: null, status: "running" });
    expect((await loadSessionHistory(database(), sessionId)).messages.at(-1)).toEqual({ role: "assistant", content: [{ type: "text", text: "доделал" }] });
  });

  it("leaves a recovered turn running for the next process when maintenance refuses admission", async () => {
    const sessionId = await newTestSession();
    const turn = await startMessageTurn(sessionId, "продолжи");
    await claimTurn(database(), turn.id, "runner-dead");
    const model = scriptedModel();
    const { observer } = recordingObserver();
    const dispatcher = createTurnDispatcher({
      admit: async () => null, runnerLock: HELD_RUNNER_LOCK, runtime: testRuntime({ agent: testAgent({}), callModel: model.callModel, observer, runnerId: "runner-new" }), waitMilliseconds: 50,
    });

    await dispatcher.recover();
    await dispatcher.idle();

    expect(model.requests).toHaveLength(0);
    expect(await loadTurn(database(), turn.id)).toMatchObject({ runnerId: null, status: "running" });
  });

  it("leaves the turns of another live process alone once this process lost the runner lock", async () => {
    const sessionId = await newTestSession();
    const turn = await startMessageTurn(sessionId, "продолжи");
    await claimTurn(database(), turn.id, "runner-other");
    const model = scriptedModel();
    const { observer } = recordingObserver();
    const dispatcher = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: { ensureHeld: async () => false },
      runtime: testRuntime({ agent: testAgent({}), callModel: model.callModel, observer, runnerId: "runner-new" }), waitMilliseconds: 50,
    });

    expect(await dispatcher.recover()).toBe(0);
    await dispatcher.idle();

    expect(model.requests).toHaveLength(0);
    expect(await loadTurn(database(), turn.id)).toMatchObject({ runnerId: "runner-other", status: "running" });
  });

  it("shows after a restart the approval card the dead process parked but never showed, once", async () => {
    const sessionId = await newTestSession();
    const model = scriptedModel(toolCalls([{ id: "call-1", input: {}, name: "change" }]));
    const dead = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: HELD_RUNNER_LOCK, waitMilliseconds: 50,
      runtime: testRuntime({
        agent: testAgent(approvalTools()), callModel: model.callModel, observer: recordingObserver({ inputRequested: DIES_HERE }).observer, runnerId: "runner-dead",
      }),
    });
    const turn = await startMessageTurn(sessionId, "измени");
    void dead.run(turn.id);
    await untilStatus(turn.id, "waiting_input");
    const { events, observer } = recordingObserver();
    const next = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: HELD_RUNNER_LOCK, waitMilliseconds: 50,
      runtime: testRuntime({ agent: testAgent(approvalTools()), callModel: model.callModel, observer, runnerId: "runner-new" }),
    });

    expect(await next.recover()).toBe(1);
    await next.idle();
    expect(await next.recover()).toBe(0);
    await next.idle();

    expect(events).toEqual([
      { kind: "inputRequested", requests: ["tool-approval"], turnId: turn.id },
      { kind: "turnFinished", outcome: "waiting_input", turnId: turn.id },
    ]);
    expect(model.requests).toHaveLength(1);
  });

  it("does not show again the card the dead process showed, and only reports that its turn waits", async () => {
    const sessionId = await newTestSession();
    const model = scriptedModel(toolCalls([{ id: "call-1", input: {}, name: "change" }]));
    const dead = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: HELD_RUNNER_LOCK, waitMilliseconds: 50,
      runtime: testRuntime({
        agent: testAgent(approvalTools()), callModel: model.callModel, observer: recordingObserver({ turnFinished: DIES_HERE }).observer, runnerId: "runner-dead",
      }),
    });
    const turn = await startMessageTurn(sessionId, "измени");
    void dead.run(turn.id);
    await untilStatus(turn.id, "waiting_input");
    const { events, observer } = recordingObserver();
    const next = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: HELD_RUNNER_LOCK, waitMilliseconds: 50,
      runtime: testRuntime({ agent: testAgent(approvalTools()), callModel: model.callModel, observer, runnerId: "runner-new" }),
    });

    // The dead process got past showing the card: it marked it shown and died reporting the wait.
    await until(async () => (await database().query(
      "SELECT 1 FROM agent_turns WHERE id = $1 AND input_presented_at IS NOT NULL", [turn.id],
    )).rowCount === 1);
    expect(await next.recover()).toBe(1);
    await next.idle();

    expect(events).toEqual([{ kind: "turnFinished", outcome: "waiting_input", turnId: turn.id }]);
  });

  it("fails after a restart a parked turn whose card cannot be shown, so its chat is not left waiting", async () => {
    const sessionId = await newTestSession();
    const model = scriptedModel(toolCalls([{ id: "call-1", input: {}, name: "change" }]));
    const dead = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: HELD_RUNNER_LOCK, waitMilliseconds: 50,
      runtime: testRuntime({
        agent: testAgent(approvalTools()), callModel: model.callModel, observer: recordingObserver({ inputRequested: DIES_HERE }).observer, runnerId: "runner-dead",
      }),
    });
    const turn = await startMessageTurn(sessionId, "измени");
    void dead.run(turn.id);
    await untilStatus(turn.id, "waiting_input");
    const { events, observer } = recordingObserver({ inputRequested: async () => { throw new Error("TEST_CARD_REFUSED"); } });
    const next = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: HELD_RUNNER_LOCK, waitMilliseconds: 50,
      runtime: testRuntime({ agent: testAgent(approvalTools()), callModel: model.callModel, observer, runnerId: "runner-new" }),
    });

    await next.recover();
    await next.idle();

    expect(await loadTurn(database(), turn.id)).toMatchObject({ errorCode: "AGENT_TURN_FAILED", status: "failed" });
    expect(events.map((event) => event.kind === "turnFinished" ? `${event.kind}:${event.outcome}` : event.kind))
      .toEqual(["inputRequested", "turnFinished:failed"]);
  });

  it("reports after a restart how a turn ended when the dead process did not get to, once", async () => {
    const sessionId = await newTestSession();
    const model = scriptedModel(reply("готово"));
    const dead = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: HELD_RUNNER_LOCK, waitMilliseconds: 50,
      runtime: testRuntime({
        agent: testAgent({}), callModel: model.callModel, observer: recordingObserver({ turnFinished: DIES_HERE }).observer, runnerId: "runner-dead",
      }),
    });
    const turn = await startMessageTurn(sessionId, "привет");
    void dead.run(turn.id);
    await untilStatus(turn.id, "completed");
    const { events, observer } = recordingObserver();
    const next = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: HELD_RUNNER_LOCK, waitMilliseconds: 50,
      runtime: testRuntime({ agent: testAgent({}), callModel: model.callModel, observer, runnerId: "runner-new" }),
    });

    expect(await next.recover()).toBe(1);
    await next.idle();
    expect(await next.recover()).toBe(0);
    await next.idle();

    expect(events).toEqual([{ kind: "turnFinished", outcome: "completed", turnId: turn.id }]);
  });

  it("shows the card at a later recovery when maintenance held the first one back", async () => {
    const sessionId = await newTestSession();
    const model = scriptedModel(toolCalls([{ id: "call-1", input: {}, name: "change" }]));
    const dead = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: HELD_RUNNER_LOCK, waitMilliseconds: 50,
      runtime: testRuntime({
        agent: testAgent(approvalTools()), callModel: model.callModel, observer: recordingObserver({ inputRequested: DIES_HERE }).observer, runnerId: "runner-dead",
      }),
    });
    const turn = await startMessageTurn(sessionId, "измени");
    void dead.run(turn.id);
    await untilStatus(turn.id, "waiting_input");
    let frozen = true;
    const { events, observer } = recordingObserver();
    const next = createTurnDispatcher({
      admit: async (work) => frozen ? null : await work(), runnerLock: HELD_RUNNER_LOCK, waitMilliseconds: 50,
      runtime: testRuntime({ agent: testAgent(approvalTools()), callModel: model.callModel, observer, runnerId: "runner-new" }),
    });

    await next.recover();
    await next.idle();
    expect(events).toEqual([]);
    frozen = false;
    expect(await next.recover()).toBe(1);
    await next.idle();

    expect(events.map((event) => event.kind)).toEqual(["inputRequested", "turnFinished"]);
  });

  it("does not report a turn again while this process is still reporting it", async () => {
    const sessionId = await newTestSession();
    const model = scriptedModel(reply("готово"));
    const release = gate();
    const reached = gate();
    const { events, observer } = recordingObserver({ turnFinished: async () => { reached.open(); await release.opened; } });
    const dispatcher = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: HELD_RUNNER_LOCK, waitMilliseconds: 50,
      runtime: testRuntime({ agent: testAgent({}), callModel: model.callModel, observer }),
    });
    const turn = await startMessageTurn(sessionId, "привет");
    const running = dispatcher.run(turn.id);
    await reached.opened;

    expect(await dispatcher.recover()).toBe(0);
    await dispatcher.idle();
    release.open();
    await running;

    expect(events.filter((event) => event.kind === "turnFinished")).toHaveLength(1);
  });

  it("keeps a turn parked when its card was shown but the mark of it could not be written", async () => {
    const sessionId = await newTestSession();
    const model = scriptedModel(toolCalls([{ id: "call-1", input: {}, name: "change" }]));
    const { events, observer } = recordingObserver();
    const dispatcher = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: HELD_RUNNER_LOCK, waitMilliseconds: 50,
      runtime: testRuntime({ agent: testAgent(approvalTools()), callModel: model.callModel, observer }),
    });
    await database().query(`CREATE FUNCTION test_refuse_presented_mark() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'TEST_MARK_REFUSED'; END $$`);
    await database().query(`CREATE TRIGGER test_refuse_presented_mark BEFORE UPDATE OF input_presented_at ON agent_turns
      FOR EACH ROW EXECUTE FUNCTION test_refuse_presented_mark()`);
    const turn = await startMessageTurn(sessionId, "измени");
    let outcome: Awaited<ReturnType<typeof dispatcher.run>>;
    try {
      outcome = await dispatcher.run(turn.id);
    } finally {
      await database().query("DROP TRIGGER test_refuse_presented_mark ON agent_turns");
      await database().query("DROP FUNCTION test_refuse_presented_mark()");
    }

    expect(outcome).toMatchObject({ status: "waiting_input" });
    expect(await loadTurn(database(), turn.id)).toMatchObject({ status: "waiting_input" });
    expect(events.flatMap((event) => event.kind === "turnFinished" ? [`turnFinished:${event.outcome}`] : event.kind === "inputRequested" ? [event.kind] : []))
      .toEqual(["inputRequested", "turnFinished:waiting_input"]);
  });

  it("leaves a parked turn to the next turn when its card fails to show while someone answered it", async () => {
    const sessionId = await newTestSession();
    const model = scriptedModel(toolCalls([{ id: "call-1", input: {}, name: "change" }]));
    const dead = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: HELD_RUNNER_LOCK, waitMilliseconds: 50,
      runtime: testRuntime({
        agent: testAgent(approvalTools()), callModel: model.callModel, observer: recordingObserver({ inputRequested: DIES_HERE }).observer, runnerId: "runner-dead",
      }),
    });
    const turn = await startMessageTurn(sessionId, "измени");
    void dead.run(turn.id);
    await untilStatus(turn.id, "waiting_input");
    // The person answers the earlier card while recovery shows it again, and that showing fails.
    const { events, observer } = recordingObserver({
      inputRequested: async (event) => {
        await respondToInput(database(), { auth: OWNER_AUTH, context: [], responses: [{ optionId: "cancel", requestId: event.requests[0]!.requestId }], sessionId });
        throw new Error("TEST_CARD_REFUSED");
      },
    });
    const next = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: HELD_RUNNER_LOCK, waitMilliseconds: 50,
      runtime: testRuntime({ agent: testAgent(approvalTools()), callModel: model.callModel, observer, runnerId: "runner-new" }),
    });

    await next.recover();
    await next.idle();

    expect(await loadTurn(database(), turn.id)).toMatchObject({ status: "completed" });
    expect(events.map((event) => event.kind)).toEqual(["inputRequested"]);
  });

  it("does not start a second report of a turn while the first runs, and lets the start wait for it", async () => {
    const sessionId = await newTestSession();
    const model = scriptedModel(reply("готово"));
    const dead = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: HELD_RUNNER_LOCK, waitMilliseconds: 50,
      runtime: testRuntime({
        agent: testAgent({}), callModel: model.callModel, observer: recordingObserver({ turnFinished: DIES_HERE }).observer, runnerId: "runner-dead",
      }),
    });
    const turn = await startMessageTurn(sessionId, "привет");
    void dead.run(turn.id);
    await untilStatus(turn.id, "completed");
    const release = gate();
    const { events, observer } = recordingObserver({ turnFinished: async () => { await release.opened; } });
    const next = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: HELD_RUNNER_LOCK, waitMilliseconds: 50,
      runtime: testRuntime({ agent: testAgent({}), callModel: model.callModel, observer, runnerId: "runner-new" }),
    });

    expect(await next.recover()).toBe(1);
    expect(await next.recover()).toBe(0);
    let reported = false;
    const waiting = next.reportsIdle().then(() => { reported = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reported).toBe(false);
    release.open();
    await waiting;
    await next.idle();

    expect(events.filter((event) => event.kind === "turnFinished")).toHaveLength(1);
  });

  it("reports nothing again that a live run reported, even when its report failed", async () => {
    const parkedSession = await newTestSession();
    const failingSession = await newTestSession();
    const model = scriptedModel(toolCalls([{ id: "call-1", input: {}, name: "change" }]), reply("готово"));
    const { events, observer } = recordingObserver({
      turnFinished: async (event) => { if (event.outcome.status === "completed") throw new Error("TEST_REPORT_FAILED"); },
    });
    const dispatcher = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runnerLock: HELD_RUNNER_LOCK, waitMilliseconds: 50,
      runtime: testRuntime({ agent: testAgent(approvalTools()), callModel: model.callModel, observer }),
    });
    const parked = await startMessageTurn(parkedSession, "измени");
    expect(await dispatcher.run(parked.id)).toMatchObject({ status: "waiting_input" });
    const failing = await startMessageTurn(failingSession, "привет");
    await expect(dispatcher.run(failing.id)).rejects.toThrow("TEST_REPORT_FAILED");
    const reported = events.length;

    expect(await dispatcher.recover()).toBe(0);
    await dispatcher.idle();

    expect(events).toHaveLength(reported);
  });
});
