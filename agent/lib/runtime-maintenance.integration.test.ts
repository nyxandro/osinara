/** Exercise the exact deploy readiness SQL against application handoff states. */
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, database } from "./database.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import { sessionRepository } from "./sessions/session-repository.js";
import { withRuntimeAdmission } from "./runtime-maintenance.js";
import { createTurnDispatcher } from "../runtime/dispatch.js";
import {
  HELD_RUNNER_LOCK, newTestSession, recordingObserver, reply, scriptedModel, startMessageTurn, testAgent, testRuntime,
} from "../runtime/turn/turn.integration-fixtures.js";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const source = readFileSync(new URL("../../scripts/production-deploy/backup.sh", import.meta.url), "utf8");
const readinessSql = /app_idle="\$\(psql_current <<'SQL'\n([\s\S]*?)\nSQL/u.exec(source)?.[1];
if (!readinessSql) throw new Error("TEST_DEPLOY_READINESS_SQL_MISSING");
async function readiness() { return Object.values((await database().query(readinessSql!)).rows[0])[0]; }

describeDatabase("deploy application readiness", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users,families,telegram_ingress_queues,runtime_admission_holders CASCADE");
  });
  afterEach(async () => {
    await database().query("TRUNCATE users,families,telegram_ingress_queues,runtime_admission_holders CASCADE");
  });
  afterAll(closeDatabase);

  it.each(["scheduled", "proactive"] as const)("cannot stop after accepting %s work before a native turn exists", async (kind) => {
    const fixture = await createMainAgentMemoryFixture();
    expect(await readiness()).toBe("idle");
    const prepared = await sessionRepository.prepareTurn({
      baseContinuationToken: `maintenance-${kind}`, familyId: fixture.familyId, groupId: fixture.groupId,
      kind: "scheduled", now: new Date(), scope: "family", telegramForumTopicId: null, userId: null,
    });
    if (kind === "proactive") await database().query("UPDATE conversation_sessions SET kind='proactive' WHERE id=$1", [prepared.id]);
    expect(await readiness()).toBe("busy");
    // No native workflow exists yet: the application handoff itself must keep the deploy waiting.
    expect((await database().query("SELECT agent_session_id FROM conversation_sessions WHERE id=$1", [prepared.id])).rows[0].agent_session_id).toBeNull();
  });

  it("defers for human input so normal FIFO can deliver both text and button responses", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await sessionRepository.prepareTurn({
      baseContinuationToken: "maintenance-question", familyId: fixture.familyId, groupId: fixture.groupId,
      kind: "canonical", now: new Date(), scope: "family", telegramForumTopicId: null, userId: null,
    });
    await database().query("UPDATE conversation_sessions SET kind='task',task_state='pending',pending_operation=true WHERE family_id=$1", [fixture.familyId]);
    expect(await readiness()).toBe("approval");
  });

  it("does not mistake a lost admission connection for completed work", async () => {
    await database().query("INSERT INTO runtime_admission_holders(id,kind) VALUES(gen_random_uuid(),'ordinary')");
    expect(await readiness()).toBe("busy");
  });

  it("stays busy while a turn started in the background runs, and idle once it ended", async () => {
    const sessionId = await newTestSession();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const modelCalled = new Promise<void>((resolve) => { started = resolve; });
    const dispatcher = createTurnDispatcher({
      admit: async (work) => await withRuntimeAdmission("callback", work),
      runnerLock: HELD_RUNNER_LOCK,
      runtime: testRuntime({
        agent: testAgent({}),
        callModel: scriptedModel(async () => { started(); await released; return reply("готово"); }).callModel,
        observer: recordingObserver().observer,
      }),
      waitMilliseconds: 50,
    });
    const turn = await startMessageTurn(sessionId, "продолжи");

    dispatcher.start(turn.id);
    await modelCalled;
    expect(await readiness()).toBe("busy");
    release();
    await dispatcher.idle();

    expect(await readiness()).toBe("idle");
  });
});
