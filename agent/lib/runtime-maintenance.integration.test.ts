/** Exercise the exact deploy readiness SQL against application handoff states. */
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "eve/channels";
import type { SessionAuth, SessionAuthContext } from "eve/context";
import { closeDatabase, database } from "./database.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import { sessionRepository } from "./sessions/session-repository.js";
import { withRuntimeAdmission } from "./runtime-maintenance.js";
import { runtimeHandoffSession, completeRuntimeHandoff, completeRuntimeSessionHandoffs } from "./runtime-handoff.js";
import { coalesceDeliveries } from "../../node_modules/eve/dist/src/harness/messages.js";

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
    expect((await database().query("SELECT eve_session_id FROM conversation_sessions WHERE id=$1", [prepared.id])).rows[0].eve_session_id).toBeNull();
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

  it("retains a timeout continuation after accepted until its own native boundary", async () => {
    const actor: SessionAuthContext = { authenticator: "telegram", principalId: "101", principalType: "user", attributes: {} };
    const respond = vi.fn().mockResolvedValue({ status: "accepted", sessionId: "eve-handoff" });
    const session = { id: "eve-handoff", respond } as unknown as Session;
    await withRuntimeAdmission("callback", async admissionId => {
      await runtimeHandoffSession(session, admissionId).respond([{ requestId: "approval-1", optionId: "cancel" }], { auth: actor });
    });
    expect(await readiness()).toBe("busy");
    const auth: SessionAuth = { current: respond.mock.calls[0]![1].auth, initiator: actor };
    await completeRuntimeHandoff(auth, "another-session");
    expect(await readiness()).toBe("busy");
    await completeRuntimeHandoff(auth, session.id);
    expect(await readiness()).toBe("idle");
  });

  it("keeps an ambiguous timeout handoff until the exact session is terminal", async () => {
    const actor: SessionAuthContext = { authenticator: "telegram", principalId: "101", principalType: "user", attributes: {} };
    const session = { id: "eve-handoff", respond: vi.fn().mockRejectedValue(new Error("lost response")) } as unknown as Session;
    await expect(withRuntimeAdmission("callback", admissionId =>
      runtimeHandoffSession(session, admissionId).respond([{ requestId: "approval-1", optionId: "cancel" }], { auth: actor }),
    )).rejects.toThrow("lost response");
    expect(await readiness()).toBe("busy");
    await completeRuntimeSessionHandoffs(session.id);
    expect(await readiness()).toBe("idle");
  });

  it("closes all responses coalesced by Eve but not a later unresolved handoff", async () => {
    const actor: SessionAuthContext = { authenticator: "telegram", principalId: "101", principalType: "user", attributes: {} };
    const respond = vi.fn().mockResolvedValue({ status: "accepted", sessionId: "eve-handoff" });
    const session = { id: "eve-handoff", respond } as unknown as Session;
    for (const requestId of ["first", "second", "first"]) {
      await withRuntimeAdmission("callback", admissionId => runtimeHandoffSession(session, admissionId)
        .respond([{ requestId, optionId: "cancel" }], { auth: actor }));
    }
    const merged = coalesceDeliveries([
      { kind: "deliver", auth: respond.mock.calls[0]![1].auth, payloads: [] },
      { kind: "deliver", auth: respond.mock.calls[1]![1].auth, payloads: [] },
      { kind: "deliver", auth: actor, payloads: [] },
    ]);
    if (!merged.auth) throw new Error("TEST_HANDOFF_AUTH_MISSING");
    const lastMergedAuth: SessionAuth = { current: merged.auth, initiator: actor };
    await completeRuntimeHandoff(lastMergedAuth, session.id);
    expect((await database().query("SELECT id FROM runtime_admission_holders")).rows)
      .toEqual([{ id: respond.mock.calls[2]![1].auth.attributes.osinaraRuntimeHandoffIds[0] }]);
    expect(await readiness()).toBe("busy");
  });
});
