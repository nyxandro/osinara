import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { closeDatabase, database } from "../lib/database.js";
import { loadSessionHistory } from "./history/history-repository.js";
import { newTurnId } from "./ids.js";
import { defineTool } from "./tool.js";
import { createTurnDispatcher } from "./dispatch.js";
import { claimTurn, loadTurn } from "./turn/journal-repository.js";
import {
  newTestSession, recordingObserver, reply, scriptedModel, startMessageTurn, testAgent, testRuntime, toolCalls,
} from "./turn/turn.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");

const ADMIT_ALWAYS = async <T>(work: () => Promise<T>) => await work();

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
      admit: ADMIT_ALWAYS, runtime: testRuntime({ agent: testAgent({}), callModel: model.callModel, observer }), waitMilliseconds: 50,
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
      admit: ADMIT_ALWAYS, runtime: testRuntime({ agent: testAgent({}), callModel: model.callModel, observer }), waitMilliseconds: 50,
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
      admit: ADMIT_ALWAYS, runtime: testRuntime({ agent: testAgent(tools), callModel: model.callModel, observer }), waitMilliseconds: 50,
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
    const childSessionId = await newTestSession();
    const turn = await startMessageTurn(sessionId, "продолжи");
    await claimTurn(database(), turn.id, "runner-dead");
    const child = await database().query<{ id: string }>(
      `INSERT INTO agent_turns (id, session_id, sequence, kind, status, parent_turn_id, parent_call_id, runner_id, auth, channel, input)
       VALUES ($3, $1, 0, 'subagent', 'running', $2, 'call-x', 'runner-dead', '{}', '{"kind":"subagent"}', '{"context":[]}')
       RETURNING id`,
      [childSessionId, turn.id, newTurnId()],
    );
    const model = scriptedModel(reply("доделал"));
    const { observer } = recordingObserver();
    const dispatcher = createTurnDispatcher({
      admit: ADMIT_ALWAYS, runtime: testRuntime({ agent: testAgent({}), callModel: model.callModel, observer, runnerId: "runner-new" }), waitMilliseconds: 50,
    });

    expect(await dispatcher.recover()).toBe(1);
    await dispatcher.idle();

    expect(await loadTurn(database(), turn.id)).toMatchObject({ finalText: "доделал", status: "completed" });
    expect(await loadTurn(database(), child.rows[0]!.id)).toMatchObject({ runnerId: null, status: "running" });
    expect((await loadSessionHistory(database(), sessionId)).messages.at(-1)).toEqual({ role: "assistant", content: [{ type: "text", text: "доделал" }] });
  });

  it("leaves a recovered turn running for the next process when maintenance refuses admission", async () => {
    const sessionId = await newTestSession();
    const turn = await startMessageTurn(sessionId, "продолжи");
    await claimTurn(database(), turn.id, "runner-dead");
    const model = scriptedModel();
    const { observer } = recordingObserver();
    const dispatcher = createTurnDispatcher({
      admit: async () => null, runtime: testRuntime({ agent: testAgent({}), callModel: model.callModel, observer, runnerId: "runner-new" }), waitMilliseconds: 50,
    });

    await dispatcher.recover();
    await dispatcher.idle();

    expect(model.requests).toHaveLength(0);
    expect(await loadTurn(database(), turn.id)).toMatchObject({ runnerId: null, status: "running" });
  });
});
