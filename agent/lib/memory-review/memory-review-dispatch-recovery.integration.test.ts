import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { database, closeDatabase } from "../database.js";
import { recoverReviewDispatches } from "./memory-review-dispatch-recovery.js";
import { createMainAgentMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { memoryReviewRepository } from "./memory-review-repository.js";
import { memoryReviewDispatchRepository } from "./memory-review-dispatch-repository.js";

const suite = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
suite("memory handoff recovery fence", () => {
  beforeEach(async () => { await database().query("TRUNCATE users,families CASCADE"); });
  afterAll(closeDatabase);
  it("keeps the original source batch and rejects a late turn of the revoked session", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await database().query(`INSERT INTO telegram_group_messages(conversation_id,group_id,telegram_message_id,sequence_id,
      actor_kind,actor_id,telegram_user_id,sender_is_bot,message_kind,content_text,sent_at)
      SELECT $1,$2,900+n,n,'user','telegram:agent-memory-author','agent-memory-author',false,'text','Сообщение',now()
      FROM generate_series(2,50) n`, [fixture.conversationId, fixture.groupId]);
    const lane = (await database().query(`INSERT INTO memory_review_lanes(conversation_id,processed_through_sequence)
      VALUES($1,0) RETURNING id`, [fixture.conversationId])).rows[0];
    const batch = (await database().query(`INSERT INTO memory_review_batches(lane_id,conversation_id,batch_kind,status,
      predecessor_sequence,from_sequence,through_sequence,source_count,lease_token,lease_expires_at)
      VALUES($1,$2,'background','pending',0,1,50,50,NULL,NULL) RETURNING id`, [lane.id, fixture.conversationId])).rows[0];
    await database().query(`INSERT INTO memory_review_batch_sources(batch_id,conversation_id,timeline_entry_id,timeline_sequence)
      SELECT $1,conversation_id,id,sequence_id FROM telegram_group_messages WHERE conversation_id=$2`, [batch.id, fixture.conversationId]);
    const session = (await database().query(`INSERT INTO conversation_sessions(thread_id,generation,family_id,group_id,scope,
      kind,task_state,conversation_key,continuation_token,started_at,last_activity_at,memory_review_batch_id)
      VALUES(gen_random_uuid(),0,$1,$2,'family','proactive','running',$3,$3,now(),now(),$4) RETURNING id`,
    [fixture.familyId, fixture.groupId, `memory-review:${batch.id}`, batch.id])).rows[0];
    await database().query(`UPDATE memory_review_batches SET status='dispatching',application_session_id=$2,
      lease_token=gen_random_uuid(),lease_expires_at=now()-interval '1 minute',recovery_protocol=1 WHERE id=$1`, [batch.id, session.id]);
    const owner = await database().connect();
    try {
      await owner.query("BEGIN");
      await owner.query("SELECT id FROM conversation_sessions WHERE id=$1 FOR UPDATE", [session.id]);
      expect(await memoryReviewDispatchRepository.claimPending({ now: new Date(),limit: 10,leaseMilliseconds: 60000 })).toEqual([]);
      expect((await database().query("SELECT status FROM memory_review_batches WHERE id=$1", [batch.id])).rows[0].status).toBe("dispatching");
    } finally { await owner.query("ROLLBACK"); owner.release(); }
    const client = await database().connect();
    try { await client.query("BEGIN"); await recoverReviewDispatches(client, new Date()); await client.query("COMMIT"); }
    finally { client.release(); }
    const row = (await database().query("SELECT status,model_recovery_generation FROM memory_review_batches WHERE id=$1", [batch.id])).rows[0];
    expect(row).toEqual({ status: "pending", model_recovery_generation: 1 });
    await expect(memoryReviewRepository.bindEveTurn({ batchId: batch.id, applicationSessionId: session.id,
      eveSessionId: "late", eveTurnId: "turn_0" })).rejects.toThrow("AGENT_MEMORY_REVIEW_TURN_BINDING_INVALID");
  });
});
