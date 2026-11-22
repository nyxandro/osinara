/**
 * Whom a record is about, said by the server from the binding (#556).
 *
 * Constructs covered:
 * - `remember` answers with the person the record was bound to.
 * - After the person changes their username, the list and the period search show the new one, while
 *   the stored text keeps what the model wrote then.
 * - A record about nobody carries no `about`.
 * - The profile card's heading names the person with their username, so namesakes differ.
 * - Search lowers another person's record by the binding, though its text names nobody, and never
 *   the asker's own.
 * - A record bound to the author whose text names another participant and not the author is refused
 *   with a code and a way out, and nothing is written; naming the author too, an author without a
 *   username, and a handle of nobody in the chat all pass (owner's decisions, 20.11.2026).
 */
import type { ToolContext } from "../runtime/tool.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { conversationRepository } from "./conversation-repository.js";
import { closeDatabase, database } from "./database.js";
import { requireMemoryAuthorization } from "./memory-context.js";
import { bindMemoryTurnSources } from "./memory-turn-source.js";
import { profileViewRepository } from "./profile-view-repository.js";
import manageMemory from "./tools/manage_memory.js";
import remember from "./tools/remember.js";
import searchMemories from "./tools/search_memories.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled) {
  if (!process.env.DATABASE_URL) throw new Error("AGENT_TEST_DATABASE_CONFIG_MISSING: Не задан DATABASE_URL");
  if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test")) {
    throw new Error("AGENT_TEST_DATABASE_UNSAFE: Требуется изолированная тестовая база");
  }
}
const describeWithDatabase = enabled ? describe : describe.skip;
const NINA_ID = "7400000001";
const OLEG_ID = "7400000002";
const QUIET_ID = "7400000003";

/** Messages 1–5: odd ones by Нина Соколова (nina_s), even ones by Олег (oleg_p); 6 by Пётр, no username. */
async function fixture() {
  const familyId = (await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Subject person') RETURNING id",
  )).rows[0]!.id;
  const ownerId = (await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'Нина') RETURNING id", [NINA_ID],
  )).rows[0]!.id;
  await database().query(
    "INSERT INTO family_memberships (family_id,user_id,role) VALUES ($1,$2,'owner')", [familyId, ownerId],
  );
  const groupId = (await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id,telegram_chat_id,title,type,message_mode,tool_allowlist)
     VALUES ($1,'-100-subject-person','Subject person','external','addressed_only',
             ARRAY['remember','search_memories','manage_memory'])
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
       'Сообщение '||n, now() - (7 - n) * interval '1 minute'
     FROM generate_series(1,6) n
     CROSS JOIN LATERAL (SELECT CASE WHEN n=6 THEN $5 WHEN n%2=1 THEN $3 ELSE $4 END AS id,
       CASE WHEN n=6 THEN NULL WHEN n%2=1 THEN 'nina_s' ELSE 'oleg_p' END AS username,
       CASE WHEN n=6 THEN 'Пётр' WHEN n%2=1 THEN 'Нина Соколова' ELSE 'Олег' END AS name) AS author
     RETURNING id,sequence_id::text`,
    [conversationId, groupId, NINA_ID, OLEG_ID, QUIET_ID],
  )).rows.sort((a, b) => Number(a.sequence_id) - Number(b.sequence_id));
  await conversationRepository.syncTimelineParticipants(conversationId, entries.map((entry) => entry.id));
  // A group has one active conversation session; the turns of a test differ by their agent session.
  const sessionId = (await database().query<{ id: string }>(
    `INSERT INTO conversation_sessions
     (thread_id,generation,family_id,group_id,scope,kind,conversation_key,continuation_token,started_at,last_activity_at)
     VALUES (gen_random_uuid(),0,$1,$2,'group','canonical','subject-person','subject-person',now(),now())
     RETURNING id`,
    [familyId, groupId],
  )).rows[0]!.id;
  return { familyId, ownerId, groupId, conversationId, entries, sessionId };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** An ordinary group turn that answers message `answered` (1-based), with every message visible. */
async function turnContext(f: Fixture, answered: number, actorId: string): Promise<ToolContext> {
  const ctx = {
    callId: "subject-person", session: {
      // Two turns of one test must not share a source set.
      id: `agent-subject-person-${answered}-${actorId}`, turn: { id: "turn_0" }, auth: { initiator: null, current: {
        authenticator: "telegram",
        principalId: f.ownerId,
        principalType: "user",
        attributes: {
          applicationSessionId: f.sessionId, familyId: f.familyId, groupId: f.groupId, groupType: "external",
          role: "external", memoryScopes: ["group"], telegramActorId: actorId,
          telegramActorKind: "telegram_user", telegramUserId: actorId,
          telegramConversationId: f.conversationId,
          telegramTimelineEntryId: f.entries[answered - 1]!.id,
          telegramTimelineVisibleEntryIds: f.entries.map((entry) => entry.id),
        },
      } },
    },
  } as unknown as ToolContext;
  await bindMemoryTurnSources(ctx);
  return ctx;
}

const input = { basis: "agent_inferred", kind: "fact", scope: "group", sensitivity: "normal" } as const;

describeWithDatabase("whom a memory record is about", () => {
  beforeEach(async () => { await database().query("TRUNCATE users,families CASCADE"); });
  afterAll(closeDatabase);

  it("says back whom remember bound the record to", async () => {
    const ctx = await turnContext(await fixture(), 5, NINA_ID);

    const saved = await remember.execute({
      ...input, content: "Нина Соколова (nina_s) любит Postgres", subject: { kind: "current_author" },
    }, { ...ctx, callId: "subject-person-saved" });

    expect(saved).toMatchObject({ item: { about: "Нина Соколова (@nina_s)" } });
  });

  it("names the person in the profile card's heading with their username", async () => {
    const f = await fixture();
    const ctx = await turnContext(f, 5, NINA_ID);
    await remember.execute({
      ...input, content: "Нина Соколова (nina_s) любит Postgres", subject: { kind: "current_author" },
    }, { ...ctx, callId: "subject-person-card" });

    const view = await profileViewRepository.create(requireMemoryAuthorization(ctx), {
      conversationId: f.conversationId,
      currentTelegramUserId: NINA_ID,
      explicitMentionTelegramUserIds: [],
      inContextMemoryRefs: new Set(),
      now: new Date(),
      provenance: { sessionId: ctx.session.id, turnId: ctx.session.turn.id },
      replyTelegramUserId: null,
    });

    expect(view.subjects.map((subject) => subject.label)).toEqual(["Нина Соколова (@nina_s)"]);
  });

  it("lowers another person's bound record when the question names someone", async () => {
    const f = await fixture();
    const fromOleg = await turnContext(f, 4, OLEG_ID);
    await remember.execute({
      ...input, content: "Стая удобная: Стая быстрая, Стая простая, Стая удобная", subject: { kind: "current_author" },
    }, { ...fromOleg, callId: "subject-person-oleg" });
    const fromNina = await turnContext(f, 5, NINA_ID);
    await remember.execute({
      ...input, content: "Стая удобная", subject: { kind: "current_author" },
    }, { ...fromNina, callId: "subject-person-nina" });

    // No embedding service in tests: the search runs on its word branches and says so.
    const found = await searchMemories.execute(
      { query: "Нина: Стая удобная?" }, { ...fromNina, callId: "subject-person-search" },
    ) as { items: { about?: string }[] };

    expect(found.items.map((record) => record.about)).toEqual(["Нина Соколова (@nina_s)", "Олег (@oleg_p)"]);

    // Олег asks the same: his own record is the answer to «я», and it is not lowered.
    const asked = await searchMemories.execute(
      { query: "Нина: Стая удобная?" }, { ...fromOleg, callId: "subject-person-search-oleg" },
    ) as { items: { about?: string }[] };
    expect(asked.items.map((record) => record.about)).toEqual(["Олег (@oleg_p)", "Нина Соколова (@nina_s)"]);
  });

  it("shows the current username after the person changed it", async () => {
    const f = await fixture();
    const ctx = await turnContext(f, 5, NINA_ID);
    await remember.execute({
      ...input, content: "Нина Соколова (nina_s) любит Postgres", subject: { kind: "current_author" },
    }, { ...ctx, callId: "subject-person-renamed" });
    await remember.execute({
      ...input, content: "Группа решила собираться по четвергам", subject: { kind: "none" },
    }, { ...ctx, callId: "subject-person-nobody" });
    const renamed = (await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
        (conversation_id,group_id,telegram_message_id,sequence_id,actor_kind,actor_id,telegram_user_id,
         sender_username,sender_display_name,sender_is_bot,message_kind,content_text,sent_at)
       VALUES ($1,$2,7,7,'user','telegram:'||$3,$3,'nina_new','Нина Соколова',false,'text','Новое',now())
       RETURNING id`,
      [f.conversationId, f.groupId, NINA_ID],
    )).rows[0]!.id;
    await conversationRepository.syncTimelineParticipants(f.conversationId, [renamed]);

    const listed = await manageMemory.execute({ action: "list" }, { ...ctx, callId: "subject-person-list" }) as {
      items: { about?: string; content: string }[];
    };
    const period = await searchMemories.execute(
      { from: "2000-01-01", query: "что известно", to: "2099-12-31" },
      { ...ctx, callId: "subject-person-period" },
    ) as { about?: string; content: string }[];

    for (const records of [listed.items, period]) {
      expect(records.find((record) => record.content.includes("Postgres")))
        .toMatchObject({ about: "Нина Соколова (@nina_new)", content: "Нина Соколова (nina_s) любит Postgres" });
      expect(records.find((record) => record.content.includes("четвергам"))).not.toHaveProperty("about");
    }
  });

  describe("a text that names another participant", () => {
    async function records(): Promise<number> {
      return (await database().query<{ n: number }>("SELECT count(*)::integer AS n FROM memory_items")).rows[0]!.n;
    }

    it("is refused with a way out, and nothing is written", async () => {
      const ctx = await turnContext(await fixture(), 4, OLEG_ID);

      const refused = await remember.execute({
        ...input, content: "Нина Соколова (nina_s) любит Postgres", subject: { kind: "current_author" },
      }, { ...ctx, callId: "subject-name-refused" }) as { code: string; correction: string; saved: boolean };

      expect(refused).toMatchObject({ code: "AGENT_MEMORY_SUBJECT_NAME_MISMATCH", saved: false });
      expect(refused.correction).toContain("«Олег (@oleg_p)»");
      expect(refused.correction).toContain("@nina_s");
      expect(refused.correction).toContain("verified_ref");
      expect(await records()).toBe(0);
    });

    it("passes when the author is named as well", async () => {
      const ctx = await turnContext(await fixture(), 4, OLEG_ID);

      const saved = await remember.execute({
        ...input, content: "Олег (oleg_p) работает вместе с Ниной (nina_s)", subject: { kind: "current_author" },
      }, { ...ctx, callId: "subject-name-both" });

      expect(saved).toMatchObject({ item: { about: "Олег (@oleg_p)" } });
    });

    it("returns the saved record to a repeat of the call, though the check would now refuse", async () => {
      const f = await fixture();
      const ctx = { ...await turnContext(f, 4, OLEG_ID), callId: "subject-name-repeat" };
      const fact = { ...input, content: "Олег (oleg_p) работает вместе с Ниной (nina_s)",
        subject: { kind: "current_author" } } as const;
      const first = await remember.execute(fact, ctx) as { item: { memoryRef: string } };
      const renamed = (await database().query<{ id: string }>(
        `INSERT INTO telegram_group_messages
          (conversation_id,group_id,telegram_message_id,sequence_id,actor_kind,actor_id,telegram_user_id,
           sender_username,sender_display_name,sender_is_bot,message_kind,content_text,sent_at)
         VALUES ($1,$2,8,8,'user','telegram:'||$3,$3,'oleg_new','Олег',false,'text','Новое',now())
         RETURNING id`,
        [f.conversationId, f.groupId, OLEG_ID],
      )).rows[0]!.id;
      await conversationRepository.syncTimelineParticipants(f.conversationId, [renamed]);

      const repeat = await remember.execute(fact, ctx);

      expect(repeat).toMatchObject({ item: { memoryRef: first.item.memoryRef } });
      expect(await records()).toBe(1);
    });

    it("refuses an episode too, which has no duplicate probe", async () => {
      const ctx = await turnContext(await fixture(), 4, OLEG_ID);

      const refused = await remember.execute({
        ...input, content: "Нина (nina_s) ездила в Казань", kind: "episode", subject: { kind: "current_author" },
      }, { ...ctx, callId: "subject-name-episode" });

      expect(refused).toMatchObject({ code: "AGENT_MEMORY_SUBJECT_NAME_MISMATCH", saved: false });
      expect(await records()).toBe(0);
    });

    it("leaves an author without a username and a handle of nobody in the chat alone", async () => {
      const f = await fixture();
      const fromPetr = await turnContext(f, 6, QUIET_ID);
      const fromOleg = await turnContext(f, 4, OLEG_ID);

      await remember.execute({
        ...input, content: "Советует Нине (nina_s) PostGIS", subject: { kind: "current_author" },
      }, { ...fromPetr, callId: "subject-name-no-username" });
      await remember.execute({
        ...input, content: "Читает канал @durov каждый день", subject: { kind: "current_author" },
      }, { ...fromOleg, callId: "subject-name-outsider" });

      expect(await records()).toBe(2);
    });
  });
});
