/** Installed Eve Telegram bridge + real PostgreSQL disconnects, including a lost commit acknowledgement. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramChannel, type TelegramDrainContext } from "eve/channels/telegram";
import { database, closeDatabase } from "./database.js";
import { createTelegramDurableIngress } from "./telegram-durable-ingress.js";
import { telegramIngressRepository } from "./telegram-ingress-repository.js";
import { bindTelegramIngressTurn } from "./telegram-ingress-binding.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import { sessionRepository } from "./sessions/session-repository.js";
import { isDatabaseUnavailable } from "./database-errors.js";

const suite = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
suite("Telegram recovery across PostgreSQL interruption", () => {
  beforeEach(async () => { await database().query("TRUNCATE users,families,telegram_ingress_queues,eve_session_event_cursors CASCADE"); });
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
    const modelCalls: string[] = [];
    const cancel = vi.fn();
    const send = vi.fn(async (_message, options) => {
      const attributes = options.auth.attributes;
      const sessionId = `eve-${attributes.osinaraTelegramUpdateId}`;
      await bindTelegramIngressTurn({ current: options.auth, initiator: options.auth }, sessionId, "turn_0");
      modelCalls.push(attributes.osinaraTelegramUpdateId);
      return { id: sessionId, cancel, getEventStream: async () => new ReadableStream({ start(c) {
        c.enqueue({ type: "turn.completed", data: { turnId: "turn_0", osinaraTelegramIngressId: attributes.osinaraTelegramIngressId } });
        c.enqueue({ type: "session.waiting", data: { turnId: "turn_0", osinaraTelegramIngressId: attributes.osinaraTelegramIngressId } });
        c.close();
      } }) };
    });
    let dispatch!: TelegramDrainContext["dispatch"];
    const channel = telegramChannel({ credentials: { webhookSecretToken: "test-secret" }, botUsername: "osinara_bot",
      onVerifiedUpdate: async ctx => { dispatch = ctx.dispatch; return new Response("ok"); },
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
    });
    const payload = (id: number) => ({ update_id: id, message: { message_id: id, date: 1700000000,
      chat: { id: -1001, type: "supergroup" }, from: { id: 101, first_name: "Owner", is_bot: false }, text: `@osinara_bot request ${id}` } });
    const route = channel.routes[0] as unknown as { handler(request: Request, context: unknown): Promise<Response> };
    await route.handler(new Request("https://example.invalid/eve/v1/telegram", { method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "test-secret" }, body: JSON.stringify(payload(1001)) }),
    { from: () => ({ send }), resolveSession: vi.fn(), attachSession: vi.fn(), waitUntil: vi.fn() });
    for (const id of [1001,1002]) await telegramIngressRepository.enqueue({ updateId: String(id), continuationKey: "-1001::", payload: payload(id) });
    const repository = { ...telegramIngressRepository, async completeWithSession(...args: Parameters<typeof telegramIngressRepository.completeWithSession>) {
      await telegramIngressRepository.completeWithSession(...args);
      if (phase === "commit-ack" && !interrupted) {
        interrupted = true;
        throw Object.assign(new Error("Lost acknowledgement of committed completion"), { code: "08006" });
      }
    } };
    const ingress = createTelegramDurableIngress({ reportFailure: vi.fn(), repository, botUsername: "osinara_bot", leaseMilliseconds: 60000,
      acceptMedia: vi.fn(), authorizeVoice: vi.fn(), handleSoftwareUpdateCallback: vi.fn(), transcribeVoice: vi.fn() });
    const work: Promise<unknown>[] = [];
    await ingress.drain({ dispatch, attachSession: vi.fn(), waitUntil: task => { work.push(task); } });
    await Promise.all(work);
    expect(modelCalls).toEqual(["1001","1002"]);
    expect(cancel).not.toHaveBeenCalled();
    expect((await database().query("SELECT status FROM telegram_ingress_updates ORDER BY update_id")).rows)
      .toEqual([{ status: "completed" },{ status: "completed" }]);
    expect((await database().query("SELECT count(*)::int AS count FROM telegram_group_messages WHERE telegram_message_id IN (1001,1002)")).rows[0].count).toBe(2);
  });
});
