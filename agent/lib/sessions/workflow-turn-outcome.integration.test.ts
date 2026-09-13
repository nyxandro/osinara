import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { readConfiguredEveTurnOutcome } from "./workflow-turn-outcome.js";

const suite = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
suite("native workflow versus agent outcome", () => {
  const pool = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
  afterAll(() => pool.end());
  it.each(["turn.failed","turn.completed","turn.cancelled"])("reads %s even though the Workflow program completed successfully", async type => {
    if (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
    const tag = crypto.randomUUID().replaceAll("-","").slice(0,26).toUpperCase();
    const id=`wrun_${tag}`;
    try {
      await pool.query("INSERT INTO workflow.workflow_runs(id,name,status,deployment_id) VALUES($1,'outcome-test','completed','test')", [id]);
      await pool.query(`INSERT INTO workflow.workflow_stream_chunks(id,stream_id,run_id,data,eof)
        VALUES($1,$2,$3,$4,false)`, [`chnk_${tag}`,`strm_${tag}_user`,id,Buffer.from(JSON.stringify({ type,data: { turnId: "turn_0" } })+"\n")]);
      expect(await readConfiguredEveTurnOutcome(id,"turn_0")).toBe(type.slice(5));
      expect(await readConfiguredEveTurnOutcome(id,"another-turn")).toBe("unknown");
    } finally {
      await pool.query("DELETE FROM workflow.workflow_stream_chunks WHERE run_id=$1", [id]);
      await pool.query("DELETE FROM workflow.workflow_runs WHERE id=$1", [id]);
    }
  });
});
