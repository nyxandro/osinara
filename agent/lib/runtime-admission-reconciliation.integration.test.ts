import { spawn } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { database, closeDatabase } from "./database.js";
import { reconcileRuntimeAdmissions, runtimeProcessIdentity } from "./runtime-admission-reconciliation.js";

const suite = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
suite("runtime admission reconciliation", () => {
  beforeEach(async () => { await database().query("TRUNCATE runtime_admission_holders"); });
  afterAll(closeDatabase);
  it("proves process death instead of expiring live or unidentified holders", async () => {
    const current = await runtimeProcessIdentity();
    const child = spawn(process.execPath,["--import","tsx","--input-type=module","-e",
      'import {runtimeProcessIdentity} from "./agent/lib/runtime-admission-reconciliation.ts"; console.log(JSON.stringify(await runtimeProcessIdentity()));'],
    { stdio: ["ignore","pipe","pipe"] });
    let output = "";
    child.stdout.on("data",chunk => { output+=chunk; });
    await new Promise<void>((resolve,reject) => {
      child.on("error",reject); child.on("exit",code => code === 0 ? resolve() : reject(new Error(`Child identity failed: ${code}`)));
    });
    const dead = JSON.parse(output) as typeof current;
    const ids = { alive: crypto.randomUUID(), dead: crypto.randomUUID(), legacy: crypto.randomUUID(), native: crypto.randomUUID() };
    for (const [id,owner] of [[ids.alive,current],[ids.dead,dead]] as const) {
      await database().query(`INSERT INTO runtime_admission_holders(id,kind,owner_hostname,owner_pid,owner_start_ticks,created_at)
        VALUES($1,'ordinary',$2,$3,$4,now()-interval '2 days')`, [id,owner.hostname,owner.pid,owner.startTicks]);
    }
    await database().query("INSERT INTO runtime_admission_holders(id,kind) VALUES($1,'ordinary')", [ids.legacy]);
    await database().query("INSERT INTO runtime_admission_holders(id,kind,eve_session_id) VALUES($1,'callback','native-session')", [ids.native]);
    await reconcileRuntimeAdmissions(async () => "running");
    const remaining = (await database().query("SELECT id FROM runtime_admission_holders")).rows.map(row => row.id).sort();
    expect(remaining).toEqual([ids.alive,ids.legacy,ids.native].sort());
    await reconcileRuntimeAdmissions(async () => "completed");
    expect((await database().query("SELECT id FROM runtime_admission_holders")).rows.map(row => row.id).sort())
      .toEqual([ids.alive,ids.legacy].sort());
  });
});
