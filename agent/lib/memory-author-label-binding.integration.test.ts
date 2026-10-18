/**
 * A fact signed with its author's own name is saved as a fact about that verified author.
 *
 * Constructs covered:
 * - The silent review: a label that names the author of the chosen message binds to that author,
 *   reaches their profile, and keeps no text label.
 * - A label naming another person in the author's message stays a text label.
 * - A bare name another participant of the chat also carries stays a text label.
 * - The call is bound before its replay key is taken: a repeat of it is a repeat, not a mismatch.
 * - An ordinary turn: the current author written by name binds the same way.
 *
 * From 27.09 to 17.10.2026 the review wrote 274 facts about the author of the chosen message under a
 * hand-written name, and none of them reached that person's profile.
 */
import type { ToolContext } from "../runtime/tool.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { conversationRepository } from "./conversation-repository.js";
import { closeDatabase, database } from "./database.js";
import { bindMemoryTurnSources } from "./memory-turn-source.js";
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
const ANNA_ID = "7200000001";
const BORIS_ID = "7200000002";
const NAMESAKE_ID = "7200000003";

/**
 * Fifty messages, odd ones by Анна (anna_k) and even ones by Boris Sokolov (boris_b); the last one
 * is by another Boris Sokolov (boris_z), spelled differently, so the bare name belongs to two people.
 * The spelling makes the SQL comparison carry the same normalization as the code.
 */
async function fixture() {
  const familyId = (await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Author labels') RETURNING id",
  )).rows[0]!.id;
  const ownerId = (await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'Анна') RETURNING id", [ANNA_ID],
  )).rows[0]!.id;
  await database().query(
    "INSERT INTO family_memberships (family_id,user_id,role) VALUES ($1,$2,'owner')", [familyId, ownerId],
  );
  const groupId = (await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id,telegram_chat_id,title,type,message_mode,tool_allowlist)
     VALUES ($1,'-100-author-labels','Author labels','external','addressed_only',ARRAY['remember'])
     RETURNING id`, [familyId],
  )).rows[0]!.id;
  const conversationId = (await database().query<{ id: string }>(
    "SELECT id FROM application_conversations WHERE telegram_group_id=$1", [groupId],
  )).rows[0]!.id;
  const entries = (await database().query<{ id: string; sequence_id: string }>(
    `INSERT INTO telegram_group_messages
      (conversation_id,group_id,telegram_message_id,sequence_id,actor_kind,actor_id,telegram_user_id,
       sender_username,sender_display_name,sender_is_bot,message_kind,content_text,sent_at)
     SELECT $1,$2,n,n,'user','telegram:'||author.id,author.id,author.username,author.name,false,'text',
       'Сообщение '||n,now()
     FROM generate_series(1,50) n
     CROSS JOIN LATERAL (SELECT CASE WHEN n=50 THEN $5 WHEN n%2=1 THEN $3 ELSE $4 END AS id,
       CASE WHEN n=50 THEN 'boris_z' WHEN n%2=1 THEN 'anna_k' ELSE 'boris_b' END AS username,
       CASE WHEN n=50 THEN 'boris  SOKOLOV' WHEN n%2=1 THEN 'Анна' ELSE 'Boris Sokolov' END AS name) AS author
     RETURNING id,sequence_id::text`,
    [conversationId, groupId, ANNA_ID, BORIS_ID, NAMESAKE_ID],
  )).rows.sort((a, b) => Number(a.sequence_id) - Number(b.sequence_id));
  await conversationRepository.syncTimelineParticipants(conversationId, entries.map((entry) => entry.id));
  return { familyId, ownerId, groupId, conversationId, entries };
}

function context(
  f: Awaited<ReturnType<typeof fixture>>,
  applicationSessionId: string,
  review?: { batchId: string; sourceEntryIds: string[] },
): ToolContext {
  return {
    callId: "remember-author-label", session: {
      id: "agent-author-labels", turn: { id: "turn_0" }, auth: { initiator: null, current: {
        authenticator: review ? "memory-review" : "telegram",
        principalId: f.ownerId,
        principalType: "user",
        attributes: {
          applicationSessionId, familyId: f.familyId, groupId: f.groupId, groupType: "external",
          role: "external", memoryScopes: ["group"], telegramActorId: ANNA_ID,
          telegramActorKind: "telegram_user", telegramUserId: ANNA_ID,
          telegramConversationId: f.conversationId,
          ...(review ? { memoryReviewBatchId: review.batchId, memoryReviewMode: "background",
            memoryReviewSourceEntryIds: review.sourceEntryIds } : {
            telegramTimelineEntryId: f.entries[48]!.id,
            telegramTimelineVisibleEntryIds: f.entries.map((entry) => entry.id),
          }),
        },
      } },
    },
  } as unknown as ToolContext;
}

const input = { basis: "agent_inferred", kind: "fact", scope: "group", sensitivity: "normal" } as const;

async function subjectOf(operationKey: string) {
  const row = await database().query<{
    profile_eligible: boolean;
    subject_label: string | null;
    subject_telegram_id: string | null;
  }>(
    `SELECT item.subject_label, item.profile_eligible, participant.telegram_user_id AS subject_telegram_id
     FROM memory_items AS item
     LEFT JOIN conversation_participants AS participant ON participant.id = item.subject_participant_id
     WHERE item.operation_key = $1`,
    [operationKey],
  );
  return row.rows[0]!;
}

async function turnContext(f: Awaited<ReturnType<typeof fixture>>): Promise<ToolContext> {
  const sessionId = (await database().query<{ id: string }>(
    `INSERT INTO conversation_sessions
     (thread_id,generation,family_id,group_id,scope,kind,conversation_key,continuation_token,started_at,last_activity_at)
     VALUES (gen_random_uuid(),0,$1,$2,'group','canonical','author-labels','author-labels',now(),now()) RETURNING id`,
    [f.familyId, f.groupId],
  )).rows[0]!.id;
  const ctx = context(f, sessionId);
  await bindMemoryTurnSources(ctx);
  return ctx;
}

async function reviewContext(f: Awaited<ReturnType<typeof fixture>>): Promise<ToolContext> {
  await memoryReviewRepository.observePassiveMessage({ groupId: f.groupId, timelineEntryId: f.entries[0]!.id });
  const [batch] = await memoryReviewDispatchRepository.claimPending({
    leaseMilliseconds: 60_000, limit: 1, now: new Date(),
  });
  const session = await memoryReviewSessionRepository.prepare(batch!, new Date());
  await memoryReviewDispatchRepository.markDispatchStarted(batch!, session.id);
  const ctx = context(f, session.id, batch!);
  await sessionRepository.bindAgentSession(session.id, ctx.session.id);
  await memoryReviewRepository.bindAgentTurn({ applicationSessionId: session.id, batchId: batch!.batchId,
    agentSessionId: ctx.session.id, agentTurnId: ctx.session.turn.id });
  await bindMemoryTurnSources(ctx);
  return ctx;
}

describeWithDatabase("a label naming the source author", () => {
  beforeEach(async () => { await database().query("TRUNCATE users,families CASCADE"); });
  afterAll(closeDatabase);

  it("binds a review fact signed with its author's name to that author", async () => {
    const ctx = await reviewContext(await fixture());

    await remember.execute({
      ...input, content: "Boris Sokolov (boris_b) пишет агентов на TypeScript", sourceSequence: "2",
      subject: { kind: "label", label: "Boris Sokolov (boris_b)" },
    }, { ...ctx, callId: "review-author-label" });

    expect(await subjectOf("review-author-label"))
      .toEqual({ profile_eligible: true, subject_label: null, subject_telegram_id: BORIS_ID });
  });

  it("keeps a label naming another person in the author's message", async () => {
    const ctx = await reviewContext(await fixture());

    await remember.execute({
      ...input, content: "Анна (anna_k) переехала в Казань", sourceSequence: "2",
      subject: { kind: "label", label: "Анна (anna_k)" },
    }, { ...ctx, callId: "review-other-label" });

    expect(await subjectOf("review-other-label"))
      .toEqual({ profile_eligible: false, subject_label: "Анна (anna_k)", subject_telegram_id: null });
  });

  it("keeps a bare name another participant of the chat also carries", async () => {
    const ctx = await reviewContext(await fixture());

    await remember.execute({
      ...input, content: "Boris Sokolov работает в «Ладоге»", sourceSequence: "2",
      subject: { kind: "label", label: "Boris Sokolov" },
    }, { ...ctx, callId: "review-namesake-label" });

    expect(await subjectOf("review-namesake-label"))
      .toEqual({ profile_eligible: false, subject_label: "Boris Sokolov", subject_telegram_id: null });
  });

  it("binds the current author written by name in an ordinary turn", async () => {
    const ctx = await turnContext(await fixture());

    await remember.execute({
      ...input, content: "Анна (anna_k) пьёт кофе без сахара", subject: { kind: "label", label: "Анна" },
    }, { ...ctx, callId: "turn-author-label" });

    expect(await subjectOf("turn-author-label"))
      .toEqual({ profile_eligible: true, subject_label: null, subject_telegram_id: ANNA_ID });
  });

  it("takes a repeat of a bound call for the same call", async () => {
    const ctx = { ...await turnContext(await fixture()), callId: "turn-repeated-call" };
    const fact = { ...input, content: "Анна (anna_k) ходит в бассейн" };

    // Bound after the replay key was taken, the two would hash differently and the repeat would be
    // refused as a different call reusing the same id.
    const first = await remember.execute({ ...fact, subject: { kind: "label", label: "Анна (anna_k)" } }, ctx) as {
      item: { memoryRef: string };
    };
    const repeat = await remember.execute({ ...fact, subject: { kind: "current_author" } }, ctx);

    expect(repeat).toMatchObject({ item: { memoryRef: first.item.memoryRef } });
    await expect(database().query("SELECT count(*)::integer AS n FROM memory_items"))
      .resolves.toMatchObject({ rows: [{ n: 1 }] });
  });
});
