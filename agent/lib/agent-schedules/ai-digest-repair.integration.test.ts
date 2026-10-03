/** Approved scenario migration uses real SQL, current memory access and an isolated workspace. */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, database } from "../database.js";
import { createThreadRepositoryFixture } from "../memory-thread-repository.integration-fixtures.js";
import { repairAiDigestSchedule, scenarioSha256 } from "./ai-digest-repair.js";
import { agentScheduleRepository } from "./agent-schedule-repository.js";
import { agentScheduleDispatchRepository } from "./agent-schedule-dispatch-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
const roots: string[] = [];

async function fixture() {
  const base = await createThreadRepositoryFixture();
  const content = "[news-digest 2026-09-12] Каналы: https://t.me/example_ai — проверенный список";
  await database().query("UPDATE memory_items SET content=$2 WHERE id=$1", [base.claimId, content]);
  const ref = (await database().query<{ memory_ref: string }>("SELECT memory_ref FROM memory_item_refs WHERE memory_item_id=$1", [base.claimId])).rows[0]!.memory_ref;
  const oldPrompt = "AI-дайджест для digest@example.com: [news-digest] сохранять в память";
  const schedule = await agentScheduleRepository.create({
    familyId: base.familyId, userId: base.userId, role: "owner", groupId: null, groupType: null,
    telegramChatId: "thread-owner", telegramChatType: "private", telegramUserId: "thread-owner",
    messageThreadId: null, forumTopicId: null,
  }, { executionContext: "isolated", firstRunAt: new Date("2027-09-13T07:00:00Z"), operationKey: "digest-fixture",
    recurrence: { kind: "daily", interval: 1 }, scenarioPrompt: oldPrompt, scope: "personal",
    timezone: "Europe/Moscow", title: "AI-дайджест", userRequest: "Новости",
  });
  const workspace = (await database().query<{ id: string }>("INSERT INTO workspaces(family_id,owner_user_id,scope) VALUES($1,$2,'personal') RETURNING id", [base.familyId, base.userId])).rows[0]!;
  const root = await mkdtemp(join(tmpdir(), "osinara-digest-repair-")); roots.push(root);
  await mkdir(join(root, workspace.id));
  const input = { scheduleId: schedule.id, expectedScenarioSha256: scenarioSha256(oldPrompt),
    expectedSourcesSha256: undefined as string | undefined,
    expectedNewScenarioSha256: undefined as string | undefined,
    mailbox: "digest@example.com", sourceMemoryRefs: [ref], apply: false };
  const preview = await repairAiDigestSchedule(input, { pool: database(), workspaceRoot: root });
  input.expectedSourcesSha256 = preview.sourcesSha256;
  input.expectedNewScenarioSha256 = preview.newScenarioSha256;
  return { ...base, content, root, workspaceId: workspace.id, oldPrompt, input };
}

describe.skipIf(!enabled)("AI digest scenario repair", () => {
  beforeEach(async () => { await database().query("TRUNCATE families, users CASCADE"); });
  afterAll(async () => { await closeDatabase(); for (const root of roots) await rm(root, { recursive: true, force: true }); });

  it("previews without writes, then preserves approved sources and updates only the exact schedule", async () => {
    const f = await fixture();
    const preview = await repairAiDigestSchedule(f.input, { pool: database(), workspaceRoot: f.root });
    expect(preview.applied).toBe(false);
    expect(await readdir(join(f.root, f.workspaceId))).toEqual([]);
    const applied = await repairAiDigestSchedule({ ...f.input, apply: true }, { pool: database(), workspaceRoot: f.root });
    expect(applied.applied).toBe(true);
    expect(await readFile(join(f.root, f.workspaceId, applied.sourcesFile), "utf8")).toContain(f.content);
    const stored = (await database().query<{ scenario_prompt: string }>("SELECT scenario_prompt FROM agent_schedules WHERE id=$1", [f.input.scheduleId])).rows[0]!.scenario_prompt;
    expect(scenarioSha256(stored)).toBe(preview.newScenarioSha256);
    expect(stored).toContain("list_proactive_deliveries");
    expect(stored).toContain(`/workspace/personal/${applied.sourcesFile}`);
    expect((await database().query("SELECT 1 FROM memory_items WHERE id=$1 AND content=$2", [f.claimId, f.content])).rowCount).toBe(1);
    await expect(repairAiDigestSchedule({ ...f.input, apply: true }, { pool: database(), workspaceRoot: f.root })).rejects.toThrow("AGENT_DIGEST_REPAIR_STALE");
  });

  it.each(["stale", "missing-source", "revoked", "leased", "changed-source", "changed-title"])("rejects %s before creating a file", async mode => {
    const f = await fixture();
    if (mode === "stale") f.input.expectedScenarioSha256 = "0".repeat(64);
    if (mode === "missing-source") f.input.sourceMemoryRefs = ["mem_" + "0".repeat(32)];
    if (mode === "revoked") await database().query("DELETE FROM family_memberships WHERE family_id=$1 AND user_id=$2", [f.familyId, f.userId]);
    if (mode === "leased") await agentScheduleDispatchRepository.claimDue({ now: new Date("2027-09-13T07:00:00Z"), limit: 1, leaseMilliseconds: 60000 });
    if (mode === "changed-source") await database().query("UPDATE memory_items SET content='new unreviewed source' WHERE id=$1", [f.claimId]);
    if (mode === "changed-title") await database().query("UPDATE agent_schedules SET title='changed title' WHERE id=$1", [f.input.scheduleId]);
    await expect(repairAiDigestSchedule({ ...f.input, apply: true }, { pool: database(), workspaceRoot: f.root })).rejects.toThrow(/AGENT_DIGEST_/);
    expect(await readdir(join(f.root, f.workspaceId))).toEqual([]);
    expect((await database().query("SELECT 1 FROM agent_schedules WHERE id=$1 AND scenario_prompt=$2", [f.input.scheduleId, f.oldPrompt])).rowCount).toBe(1);
  });

  it("does not overwrite an existing sources file", async () => {
    const f = await fixture();
    const path = join(f.root, f.workspaceId, `news-digest-sources-${f.input.scheduleId}.md`);
    await writeFile(path, "user-owned sources");
    await expect(repairAiDigestSchedule({ ...f.input, apply: true }, { pool: database(), workspaceRoot: f.root }))
      .rejects.toThrow("AGENT_DIGEST_SOURCES_EXIST");
    expect(await readFile(path, "utf8")).toBe("user-owned sources");
  });

  it("serializes competing repairs and never copies sources twice", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([1, 2].map(() => repairAiDigestSchedule(
      { ...f.input, apply: true }, { pool: database(), workspaceRoot: f.root },
    )));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await readdir(join(f.root, f.workspaceId))).toHaveLength(1);
    expect((await database().query("SELECT 1 FROM audit_events WHERE subject_id=$1 AND event_type='agent_schedule.digest_repaired'", [f.input.scheduleId])).rowCount).toBe(1);
  });

  it("reports a partial repair after file publication and SQL rollback without deleting or retrying the file", async () => {
    const f = await fixture();
    await database().query(`CREATE FUNCTION test_reject_digest_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'TEST_DIGEST_UPDATE_FAILED'; END $$;
      CREATE TRIGGER test_reject_digest_update BEFORE UPDATE ON agent_schedules
      FOR EACH ROW EXECUTE FUNCTION test_reject_digest_update()`);
    try {
      await expect(repairAiDigestSchedule({ ...f.input, apply: true }, { pool: database(), workspaceRoot: f.root }))
        .rejects.toMatchObject({ code: "AGENT_DIGEST_REPAIR_INCOMPLETE", cause: expect.any(Error) });
      const path = join(f.root, f.workspaceId, `news-digest-sources-${f.input.scheduleId}.md`);
      expect(await readFile(path, "utf8")).toContain(f.content);
      expect((await database().query("SELECT 1 FROM agent_schedules WHERE id=$1 AND scenario_prompt=$2", [f.input.scheduleId, f.oldPrompt])).rowCount).toBe(1);
      expect((await database().query("SELECT 1 FROM audit_events WHERE subject_id=$1 AND event_type='agent_schedule.digest_repaired'", [f.input.scheduleId])).rowCount).toBe(0);
      await expect(repairAiDigestSchedule({ ...f.input, apply: true }, { pool: database(), workspaceRoot: f.root }))
        .rejects.toThrow("AGENT_DIGEST_SOURCES_EXIST");
    } finally {
      await database().query("DROP TRIGGER test_reject_digest_update ON agent_schedules; DROP FUNCTION test_reject_digest_update()");
    }
  });
});
