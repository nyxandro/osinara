import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { database, closeDatabase } from "./database.js";
import { reconcileRuntimeAdmissions, runtimeProcessIdentity } from "./runtime-admission-reconciliation.js";
import { isRuntimeAdmissionActive, withRuntimeAdmission } from "./runtime-maintenance.js";

type ProcessIdentity = Awaited<ReturnType<typeof runtimeProcessIdentity>>;
const REPORT_IDENTITY = 'import {runtimeProcessIdentity} from "./agent/lib/runtime-admission-reconciliation.ts"; '
  + "console.log(JSON.stringify(await runtimeProcessIdentity()));";

function spawnReporter(script: string): ChildProcess {
  return spawn(process.execPath,["--import","tsx","--input-type=module","-e",script], { stdio: ["ignore","pipe","inherit"] });
}

async function exitedProcessIdentity(): Promise<ProcessIdentity> {
  const child = spawnReporter(REPORT_IDENTITY);
  let output = "";
  child.stdout!.on("data",chunk => { output+=chunk; });
  await new Promise<void>((resolve,reject) => {
    child.on("error",reject); child.on("close",code => code === 0 ? resolve() : reject(new Error(`Child identity failed: ${code}`)));
  });
  return JSON.parse(output) as ProcessIdentity;
}

/** Another live process of this container, such as a manual update check: it runs until the test ends it. */
async function runningProcessIdentity(children: ChildProcess[]): Promise<ProcessIdentity> {
  const child = spawnReporter(`${REPORT_IDENTITY} setInterval(() => {}, 60_000);`);
  children.push(child);
  const identity = await new Promise<ProcessIdentity>((resolve,reject) => {
    let output = "";
    child.on("error",reject);
    child.on("exit",code => reject(new Error(`Child exited before reporting its identity: ${code}`)));
    child.stdout!.on("data",chunk => {
      output+=chunk;
      const end = output.indexOf("\n");
      if (end >= 0) resolve(JSON.parse(output.slice(0,end)) as ProcessIdentity);
    });
  });
  return identity;
}

const suite = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
suite("runtime admission reconciliation", () => {
  const children: ChildProcess[] = [];
  beforeEach(async () => { await database().query("TRUNCATE runtime_admission_holders"); });
  afterEach(() => { for (const child of children.splice(0)) child.kill(); });
  // The holders table is global: a file that leaves rows behind breaks whichever suite counts them next.
  afterAll(async () => {
    await database().query("TRUNCATE runtime_admission_holders");
    await closeDatabase();
  });
  it("releases exited processes and settled work of this one, never running work or another live process", async () => {
    const current = await runtimeProcessIdentity();
    // Each tsx child takes about a second to start; together they stay inside the default test timeout.
    const [exited,running] = await Promise.all([exitedProcessIdentity(),runningProcessIdentity(children)]);
    // `settled` is the 19.11 holder (#553): this live process finished the work, but the release never reached the database.
    const ids = { exited: crypto.randomUUID(), legacy: crypto.randomUUID(), otherLive: crypto.randomUUID(), settled: crypto.randomUUID() };
    for (const [id,owner] of [[ids.settled,current],[ids.exited,exited],[ids.otherLive,running]] as const) {
      await database().query(`INSERT INTO runtime_admission_holders(id,kind,owner_hostname,owner_pid,owner_start_ticks,created_at)
        VALUES($1,'ordinary',$2,$3,$4,now()-interval '2 days')`, [id,owner.hostname,owner.pid,owner.startTicks]);
    }
    await database().query("INSERT INTO runtime_admission_holders(id,kind) VALUES($1,'ordinary')", [ids.legacy]);

    const observed = await withRuntimeAdmission("ordinary", async (runningHere) => {
      await reconcileRuntimeAdmissions(isRuntimeAdmissionActive);
      const rows = await database().query<{ id: string }>("SELECT id FROM runtime_admission_holders");
      return { remaining: rows.rows.map(row => row.id).sort(), runningHere };
    });

    expect(observed!.remaining).toEqual([observed!.runningHere,ids.legacy,ids.otherLive].sort());
  });
});
