/** The durable ingress over the runtime's Telegram path with real PostgreSQL disconnects, including a lost commit acknowledgement. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { database, closeDatabase } from "./database.js";
import { createTelegramDurableIngress } from "./telegram-durable-ingress.js";
import { telegramIngressRepository } from "./telegram-ingress-repository.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import { sessionRepository } from "./sessions/session-repository.js";
import { isDatabaseUnavailable } from "./database-errors.js";
import { reply } from "../runtime/turn/turn.integration-fixtures.js";
import { runtimeTelegram } from "./telegram-runtime.integration-fixtures.js";

const suite = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
suite("Telegram recovery across PostgreSQL interruption", () => {
  beforeEach(async () => { await database().query("TRUNCATE users,families,telegram_ingress_queues CASCADE"); });
  afterAll(closeDatabase);
  it("normalizes the Pool.query early client-error event before pg's query callback", async () => {
    const pool=database();
    const acquired=new Promise<import("pg").PoolClient>(resolve => pool.once("acquire",resolve));
    const failed=pool.query("SELECT pg_sleep(10)").catch(error => error);
    const client=await acquired;
    const raw=Object.assign(new Error("socket reset"),{ code: "ECONNRESET" });
    client.emit("error",raw);
    const error=await failed;
    expect(error).toMatchObject({ code: "AGENT_DATABASE_UNAVAILABLE",cause: raw });
    expect(isDatabaseUnavailable(error)).toBe(true);
  });
  it("keeps the original transaction failure when ROLLBACK also loses its connection", async () => {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const failed = client.query("SELECT pg_sleep(10)").catch(error => error);
      await database().query("SELECT pg_terminate_backend($1)", [pid]);
      const original = await failed;
      const rollback = await client.query("ROLLBACK").catch(error => error);
      expect(rollback).toBeInstanceOf(AggregateError);
      expect(rollback.cause).toBe(original);
      expect(isDatabaseUnavailable(rollback)).toBe(true);
    } finally { client.release(true); }
  });
  it.each(["preparation", "commit-ack"] as const)("preserves both requests and performs each model turn once after %s loss", async phase => {
    const fixture = await createMainAgentMemoryFixture();
    await database().query("UPDATE users SET telegram_user_id='101' WHERE id=$1", [fixture.userId]);
    await database().query("UPDATE telegram_groups SET telegram_chat_id='-1001' WHERE id=$1", [fixture.groupId]);
    const app = await sessionRepository.prepareTurn({ baseContinuationToken: "test-recovery", familyId: fixture.familyId,
      groupId: fixture.groupId, kind: "canonical", now: new Date(), scope: "family", telegramForumTopicId: null, userId: null });
    let interrupted = false;
    const telegram = runtimeTelegram({
      onMessage: async (_ctx, message) => {
        await database().query(`INSERT INTO telegram_group_messages(conversation_id,group_id,telegram_message_id,sequence_id,actor_kind,
          actor_id,telegram_user_id,sender_is_bot,message_kind,content_text,sent_at)
          VALUES($1,$2,$3,$3,'user','telegram:101','101',false,'text',$4,now()) ON CONFLICT(group_id,telegram_message_id) DO NOTHING`,
        [fixture.conversationId,fixture.groupId,message.messageId,message.text]);
        if (phase === "preparation" && !interrupted) {
          interrupted = true;
          const client = await database().connect();
          try {
            const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            const query = client.query("SELECT pg_sleep(10)");
            const failure = query.catch(error => error);
            await database().query("SELECT pg_terminate_backend($1)", [pid]);
            throw await failure;
          } finally { client.release(true); }
        }
        return { auth: { authenticator: "telegram", principalId: fixture.userId, principalType: "user", attributes: {
          applicationSessionId: app.id, familyId: fixture.familyId, groupId: fixture.groupId, groupType: "family_private",
          role: "owner", memoryScopes: ["family"], telegramChatId: "-1001",
        } }, continuationToken: "test-recovery", message: message.text };
      },
      steps: [reply("первый ответ"), reply("второй ответ")],
    });
    const payload = (id: number) => ({ update_id: id, message: { message_id: id, date: 1700000000,
      chat: { id: -1001, type: "supergroup" }, from: { id: 101, first_name: "Owner", is_bot: false }, text: `@osinara_bot request ${id}` } });
    for (const id of [1001,1002]) await telegramIngressRepository.enqueue({ updateId: String(id), continuationKey: "-1001::", payload: payload(id) });
    const repository = { ...telegramIngressRepository, async complete(...args: Parameters<typeof telegramIngressRepository.complete>) {
      await telegramIngressRepository.complete(...args);
      if (phase === "commit-ack" && !interrupted && args[2] !== undefined) {
        interrupted = true;
        throw Object.assign(new Error("Lost acknowledgement of committed completion"), { code: "08006" });
      }
    } };
    const ingress = createTelegramDurableIngress({ reportFailure: vi.fn(), repository, botUsername: "osinara_bot", leaseMilliseconds: 60000,
      acceptMedia: vi.fn(), authorizeVoice: vi.fn(), dispatch: telegram.dispatch, handleSoftwareUpdateCallback: vi.fn(),
      runTurn: telegram.runTurn, transcribeVoice: vi.fn() });
    const work: Promise<unknown>[] = [];
    await ingress.drain({ waitUntil: task => { work.push(task); } });
    await Promise.all(work);
    // Each request reached the model once, in order, in the one session of its address.
    expect(telegram.model.requests.map((request) => (request.messages.at(-1) as { content: unknown }).content)).toEqual([
      "@osinara_bot request 1001", "@osinara_bot request 1002",
    ]);
    expect((await database().query("SELECT status FROM telegram_ingress_updates ORDER BY update_id")).rows)
      .toEqual([{ status: "completed" },{ status: "completed" }]);
    expect((await database().query("SELECT count(*)::int AS count FROM telegram_group_messages WHERE telegram_message_id IN (1001,1002)")).rows[0].count).toBe(2);
  });
});
