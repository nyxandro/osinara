/** Human and bot sources share the full memory path, without manufacturing a human account. */
import type { ToolContext } from "eve/tools";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { conversationRepository } from "./conversation-repository.js";
import { closeDatabase, database } from "./database.js";
import { bindMemoryTurnSources } from "./memory-turn-source.js";
import { memoryTurnSourceRepository } from "./memory-turn-source-repository.js";
import { memoryReviewRepository } from "./memory-review/memory-review-repository.js";
import { memoryReviewDispatchRepository } from "./memory-review/memory-review-dispatch-repository.js";
import { memoryReviewSessionRepository } from "./memory-review/memory-review-session-repository.js";
import remember from "./tools/remember.js";
import { sessionRepository } from "./sessions/session-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled) {
  if (!process.env.DATABASE_URL) throw new Error("AGENT_TEST_DATABASE_CONFIG_MISSING: Не задан DATABASE_URL");
  if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test")) {
    throw new Error("AGENT_TEST_DATABASE_UNSAFE: Требуется изолированная тестовая база");
  }
}
const describeWithDatabase = enabled ? describe : describe.skip;
const HUMAN_ID = "7100000001";
const BOT_ID = "8123456789";

async function fixture() {
  const familyId = (await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Bot memory') RETURNING id",
  )).rows[0]!.id;
  const ownerId = (await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'Анна') RETURNING id", [HUMAN_ID],
  )).rows[0]!.id;
  await database().query("INSERT INTO family_memberships (family_id,user_id,role) VALUES ($1,$2,'owner')", [familyId, ownerId]);
  const groupId = (await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id,telegram_chat_id,title,type,message_mode,tool_allowlist)
     VALUES ($1,'-100-bot-memory','Bot memory','external','addressed_only',ARRAY['remember']) RETURNING id`, [familyId],
  )).rows[0]!.id;
  const conversationId = (await database().query<{ id: string }>(
    "SELECT id FROM application_conversations WHERE telegram_group_id=$1", [groupId],
  )).rows[0]!.id;
  const entries = (await database().query<{ id: string; sequence_id: string }>(
    `INSERT INTO telegram_group_messages
      (conversation_id,group_id,telegram_message_id,sequence_id,actor_kind,actor_id,
       telegram_user_id,sender_display_name,sender_is_bot,message_kind,content_text,sent_at)
     SELECT $1,$2,n,n,CASE WHEN n=50 THEN 'telegram_bot' ELSE 'user' END,
       CASE WHEN n=50 THEN 'telegram-bot:'||$4 ELSE 'telegram:'||$3 END,
       CASE WHEN n=50 THEN $4 ELSE $3 END,CASE WHEN n=50 THEN 'Мия' ELSE 'Анна' END,
       n=50,'text',CASE WHEN n=50 THEN 'Я использую сервис Markmap для схем' ELSE 'Я изучаю TypeScript' END,now()
     FROM generate_series(1,50) n RETURNING id,sequence_id::text`,
    [conversationId, groupId, HUMAN_ID, BOT_ID],
  )).rows.sort((a, b) => Number(a.sequence_id) - Number(b.sequence_id));
  await conversationRepository.syncTimelineParticipants(conversationId, entries.map((entry) => entry.id));
  return { familyId, ownerId, groupId, conversationId, entries };
}

function context(f: Awaited<ReturnType<typeof fixture>>, applicationSessionId: string, bot: boolean,
  review?: { batchId: string; sourceEntryIds: string[] }): ToolContext {
  const actor = bot ? BOT_ID : HUMAN_ID;
  return {
    callId: "remember-bot-source", session: {
      id: "eve-bot-memory", turn: { id: "turn_0" }, auth: { initiator: null, current: {
        authenticator: review ? "memory-review" : "telegram",
        principalId: bot ? `telegram-bot:${BOT_ID}` : f.ownerId,
        principalType: bot ? "service" : "user",
        attributes: {
          applicationSessionId, familyId: f.familyId, groupId: f.groupId, groupType: "external",
          role: "external", memoryScopes: ["group"], telegramActorId: actor,
          telegramActorKind: bot ? "telegram_bot" : "telegram_user", telegramUserId: actor,
          telegramConversationId: f.conversationId,
          ...(review ? { memoryReviewBatchId: review.batchId, memoryReviewMode: "background",
            memoryReviewSourceEntryIds: review.sourceEntryIds } : {
            telegramTimelineEntryId: f.entries[bot ? 49 : 48]!.id,
            telegramTimelineVisibleEntryIds: f.entries.map((entry) => entry.id),
          }),
        },
      } },
    },
  } as unknown as ToolContext;
}

const input = { basis: "agent_inferred", content: "Мия использует Markmap для схем",
  kind: "fact", scope: "group", sensitivity: "normal", subject: { kind: "current_author" } } as const;

async function expectBotAuthor() {
  await expect(database().query(
    `SELECT item.author_user_id,item.author_telegram_user_id,item.subject_user_id,
      participant.telegram_user_id AS subject_telegram_id,evidence.author_label_snapshot,
      evidence.timeline_sequence::text
     FROM memory_items item JOIN claim_evidence evidence ON evidence.claim_id=item.id
     JOIN conversation_participants participant ON participant.id=item.subject_participant_id
     WHERE item.operation_key='remember-bot-source'`,
  )).resolves.toMatchObject({ rows: [{ author_user_id: null, author_telegram_user_id: BOT_ID,
    subject_user_id: null, subject_telegram_id: BOT_ID, author_label_snapshot: "Мия", timeline_sequence: "50" }] });
  await expect(database().query("SELECT count(*)::integer AS n FROM users WHERE telegram_user_id=$1", [BOT_ID]))
    .resolves.toMatchObject({ rows: [{ n: 0 }] });
}

describeWithDatabase("bot memory source end-to-end", () => {
  beforeEach(async () => { await database().query("TRUNCATE users,families CASCADE"); });
  afterAll(closeDatabase);

  it.each([true, false])("saves a bot source from an ordinary turn (bot caller=%s)", async (bot) => {
    const f = await fixture();
    const sessionId = (await database().query<{ id: string }>(
      `INSERT INTO conversation_sessions
       (thread_id,generation,family_id,group_id,scope,kind,conversation_key,continuation_token,started_at,last_activity_at)
       VALUES (gen_random_uuid(),0,$1,$2,'group','canonical','bot-memory','bot-memory',now(),now()) RETURNING id`,
      [f.familyId, f.groupId],
    )).rows[0]!.id;
    const ctx = context(f, sessionId, bot);
    await bindMemoryTurnSources(ctx);
    await expect(remember.execute({ ...input, ...(bot ? {} : { sourceSequence: "50" }) }, ctx))
      .resolves.toMatchObject({ item: { content: input.content, scope: "group" } });
    await expectBotAuthor();
    await expect(memoryTurnSourceRepository.resolve({ eveSessionId: ctx.session.id,
      eveTurnId: ctx.session.turn.id, sourceSequence: "51" })).resolves.toBeNull();
    await expect(remember.execute({ ...input, scope: "personal" }, ctx)).rejects.toMatchObject({ code: "AGENT_MEMORY_SCOPE_DENIED" });
  });

  it("lets a bot's fiftieth message trigger the same background batch", async () => {
    const f = await fixture();
    await memoryReviewRepository.observePassiveMessage({ groupId: f.groupId, timelineEntryId: f.entries[0]!.id });
    await expect(memoryReviewRepository.observePassiveMessage({ groupId: f.groupId, timelineEntryId: f.entries[49]!.id }))
      .resolves.toMatchObject({ sourceCount: 50 });
  });

  it.each(["agent_self", "telegram_channel"])("does not turn %s into an independent fact source", async (kind) => {
    const f = await fixture();
    await database().query(
      `UPDATE telegram_group_messages SET actor_kind=$2,telegram_user_id=NULL,
        telegram_sender_chat_id=CASE WHEN $2='telegram_channel' THEN '-100999' ELSE NULL END,
        actor_id=CASE WHEN $2='telegram_channel' THEN 'telegram-channel:-100999' ELSE 'agent:self' END,
        sender_is_bot=($2='agent_self') WHERE id=$1`, [f.entries[49]!.id, kind],
    );
    const sessionId = (await database().query<{ id: string }>(
      `INSERT INTO conversation_sessions
       (thread_id,generation,family_id,group_id,scope,kind,conversation_key,continuation_token,started_at,last_activity_at)
       VALUES (gen_random_uuid(),0,$1,$2,'group','canonical','excluded-source','excluded-source',now(),now()) RETURNING id`,
      [f.familyId, f.groupId],
    )).rows[0]!.id;
    const ctx = context(f, sessionId, false);
    await bindMemoryTurnSources(ctx);
    await expect(remember.execute({ ...input, sourceSequence: "50" }, ctx))
      .rejects.toMatchObject({ code: "AGENT_MEMORY_EXPLICIT_SOURCE_INVALID" });
    await expect(database().query("SELECT count(*)::integer AS n FROM memory_items"))
      .resolves.toMatchObject({ rows: [{ n: 0 }] });
  });

  it("binds all 49 human and 1 bot sources, saves both, and completes the lane", async () => {
    const f = await fixture();
    await memoryReviewRepository.observePassiveMessage({ groupId: f.groupId, timelineEntryId: f.entries[0]!.id });
    const [batch] = await memoryReviewDispatchRepository.claimPending({ leaseMilliseconds: 60_000, limit: 1, now: new Date() });
    expect(batch!.sourceCount).toBe(50);
    const rendered = batch!.prompt.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    const session = await memoryReviewSessionRepository.prepare(batch!, new Date());
    await memoryReviewDispatchRepository.markDispatchStarted(batch!, session.id);
    const ctx = context(f, session.id, false, batch!);
    await sessionRepository.bindEveSession(session.id, ctx.session.id);
    await memoryReviewRepository.bindEveTurn({ applicationSessionId: session.id, batchId: batch!.batchId,
      eveSessionId: ctx.session.id, eveTurnId: ctx.session.turn.id });
    await bindMemoryTurnSources(ctx);
    expect(rendered.filter((entry) => entry.actor === "telegram_bot")).toHaveLength(1);
    await remember.execute({ ...input, sourceSequence: "50" }, ctx);
    await expectBotAuthor();
    await remember.execute({ ...input, sourceSequence: "1", content: "Анна изучает TypeScript" },
      { ...ctx, callId: "remember-human-source" });
    await expect(database().query("SELECT count(*)::integer AS n FROM memory_items"))
      .resolves.toMatchObject({ rows: [{ n: 2 }] });
    await memoryReviewRepository.completeBatch({ batchId: batch!.batchId, completedAt: new Date(),
      eveSessionId: ctx.session.id, eveTurnId: ctx.session.turn.id });
    expect(await memoryReviewRepository.getLaneCursor({ conversationId: f.conversationId, messageThreadId: null })).toBe("50");
  });
});
