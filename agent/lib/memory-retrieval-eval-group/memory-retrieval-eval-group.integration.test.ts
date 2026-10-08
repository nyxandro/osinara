/**
 * Retrieval quality in an external group chat.
 *
 * Constructs covered:
 * - A participant of one external group asks the questions a live group asks: about one person,
 *   a tool several people use, the bot itself, a link, other words for the same thing — and,
 *   most often, nothing at all.
 * - Isolation: nothing from another group, the owner's personal memory, or the family's memory
 *   ever reaches the group's selection, though each holds a close answer to its questions. It is
 *   checked for both kinds of reader a group has: an outsider, and the family owner, who keeps
 *   their identity in the group and is held off their own memory by the group's scope alone.
 * - The bait is live: each area's own reader finds it with a question that, asked in the group,
 *   must find nothing of it — so isolation cannot pass because the bait was never searchable.
 * - The measured baseline is pinned exactly, failures included, the same practice as v3.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { MEMORY_RETRIEVAL_LIMIT } from "../memory-config.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { prepareMemoryQuery } from "../memory-query-preparation.js";
import {
  categoryRate,
  evalAutomaticSelection,
  evalRecordId,
  evalResultKeys,
  evalShare as share,
  indexEvalRecords,
  retrievalEvalsEnabled,
} from "../memory-retrieval-eval-support.js";
import {
  MEMORY_RETRIEVAL_EVAL_GROUP_BASELINE,
  MEMORY_RETRIEVAL_EVAL_GROUP_FIXTURE_VERSION,
  MEMORY_RETRIEVAL_EVAL_GROUP_QUERIES,
  MEMORY_RETRIEVAL_EVAL_GROUP_RECORDS,
} from "./index.js";
import type {
  MemoryRetrievalEvalGroupArea,
  MemoryRetrievalEvalGroupCategory,
  MemoryRetrievalEvalGroupQuery,
} from "./types.js";

const describeEval = retrievalEvalsEnabled() ? describe : describe.skip;

// Production fills every one of the twelve slots, so quality is measured at the same depth.
const EVAL_RESULT_LIMIT = MEMORY_RETRIEVAL_LIMIT;
const EVAL_TOP_POSITIONS = 3;
const EVAL_SETUP_TIMEOUT_MILLISECONDS = 300_000;
const EVAL_MEASUREMENT_TIMEOUT_MILLISECONDS = 120_000;
const EMPTY_CATEGORIES: readonly MemoryRetrievalEvalGroupCategory[] = ["participant_near_miss", "small_talk"];

/** One bait question per area: its own reader must find the bait, a reader in the group must not. */
const BAIT_PROBES: readonly { area: MemoryRetrievalEvalGroupArea; expectedKey: string; text: string }[] = [
  { area: "board_club", expectedKey: "club-bot-voice", text: "какой голос у бота клуба?" },
  { area: "owner_personal", expectedKey: "owner-hub-token", text: "где лежит токен от хаба Нейроузел?" },
  { area: "owner_family", expectedKey: "family-avatar", text: "какой аватар у семейного чата?" },
];

interface EvaluatedGroupQuery {
  foundExpectedKeys: string[];
  hit: boolean;
  query: MemoryRetrievalEvalGroupQuery;
  resultKeys: string[];
  topPositionHit: boolean;
}

function rateOf(
  evaluated: readonly EvaluatedGroupQuery[],
  category: MemoryRetrievalEvalGroupCategory,
  passes: (entry: EvaluatedGroupQuery) => boolean,
): number {
  return categoryRate(evaluated, category, passes);
}

describeEval("memory retrieval eval: external group", () => {
  const readers = new Map<MemoryRetrievalEvalGroupArea, MemoryAuthorization>();
  /** The family owner writing in the measured chat: their identity kept, the group's scope only. */
  let ownerInChat: MemoryAuthorization;
  const keyByContent = new Map(MEMORY_RETRIEVAL_EVAL_GROUP_RECORDS.map((record) => [record.content, record.key]));
  const areaByKey = new Map(MEMORY_RETRIEVAL_EVAL_GROUP_RECORDS.map((record) => [record.key, record.area]));
  const subjectByKey = new Map(MEMORY_RETRIEVAL_EVAL_GROUP_RECORDS.map((record) => [record.key, record.subjectLabel]));

  async function search(reader: MemoryAuthorization, text: string): Promise<string[]> {
    // The same text the product searches by: preparation runs before retrieval in production.
    const prepared = prepareMemoryQuery(text);
    const { results } = await evalAutomaticSelection(reader, prepared, EVAL_RESULT_LIMIT);
    return evalResultKeys(results.map((result) => result.memory.content), keyByContent);
  }

  beforeAll(async () => {
    await database().query(
      "TRUNCATE memory_embedding_chunks, memory_embedding_jobs, memory_items_all, telegram_groups, family_memberships, users, families CASCADE",
    );
    const family = (await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Семья Арсеньевых') RETURNING id",
    )).rows[0]!.id;
    const owner = (await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('7000', 'Глеб') RETURNING id",
    )).rows[0]!.id;
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [family, owner],
    );
    const groups = await database().query<{ id: string; title: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-1007001', 'Агентная кухня', 'external', 'addressed_only'),
              ($1, '-1007002', 'Клуб настолок', 'external', 'addressed_only')
       RETURNING id, title`,
      [family],
    );
    const groupId = (title: string) => groups.rows.find((row) => row.title === title)!.id;
    const participant = (group: string, telegramUserId: string): MemoryAuthorization => ({
      familyId: family, groupId: groupId(group), role: "external", scopes: ["group"],
      telegramActorId: telegramUserId, telegramActorKind: "telegram_user", telegramUserId, userId: null,
    });
    const ownerPrivate: MemoryAuthorization = {
      familyId: family, groupId: null, role: "owner", scopes: ["personal", "family"],
      telegramActorId: "7000", telegramActorKind: "telegram_user", telegramUserId: "7000", userId: owner,
    };
    readers.set("agents_chat", participant("Агентная кухня", "7001"));
    readers.set("board_club", participant("Клуб настолок", "7002"));
    readers.set("owner_personal", ownerPrivate);
    readers.set("owner_family", ownerPrivate);
    // As production resolves the owner in an external group: same person, group scope only.
    ownerInChat = { ...ownerPrivate, groupId: groupId("Агентная кухня"), scopes: ["group"] };

    await indexEvalRecords(MEMORY_RETRIEVAL_EVAL_GROUP_RECORDS, async (record) => {
      const inGroup = record.area === "agents_chat" || record.area === "board_club";
      const inserted = await database().query<{ id: string }>(
        // The subject label is stored, as production stores it: the search reads it to prefer the
        // person a question names (#343), and without it that rule could not be measured here.
        `INSERT INTO memory_items
           (id, family_id, group_id, owner_user_id, author_user_id, author_telegram_user_id, scope,
            kind, content, source, confirmation, sensitivity, operation_key, embedding_status, updated_at,
            subject_label)
         VALUES ($12, $1, $2, $3, $4, $5, $6, $7, $8, 'eval:retrieval-group', $9, 'normal', $10,
                 'indexed', $11, $13)
         RETURNING id`,
        [
          family,
          inGroup ? readers.get(record.area)!.groupId : null,
          record.area === "owner_personal" ? owner : null,
          inGroup ? null : owner,
          inGroup ? "7003" : "7000",
          inGroup ? "group" : record.area === "owner_personal" ? "personal" : "family",
          record.kind,
          record.content,
          inGroup ? "model_high" : "user_confirmed",
          record.key,
          record.updatedAt,
          evalRecordId(record.key),
          record.subjectLabel ?? null,
        ],
      );
      return inserted.rows[0]!.id;
    });
  }, EVAL_SETUP_TIMEOUT_MILLISECONDS);

  afterAll(async () => closeDatabase());

  it("finds every bait record from its own area, so isolation is tested against live records", async () => {
    for (const probe of BAIT_PROBES) {
      expect({ area: probe.area, found: (await search(readers.get(probe.area)!, probe.text)).includes(probe.expectedKey) })
        .toEqual({ area: probe.area, found: true });
    }
  }, EVAL_MEASUREMENT_TIMEOUT_MILLISECONDS);

  it("never offers another area's record to anyone writing in the group", async () => {
    const texts = [...MEMORY_RETRIEVAL_EVAL_GROUP_QUERIES.map((query) => query.text), ...BAIT_PROBES.map((probe) => probe.text)];
    const leaks: string[] = [];
    for (const [reader, auth] of [["outsider", readers.get("agents_chat")!], ["owner", ownerInChat]] as const) {
      for (const text of texts) {
        for (const key of await search(auth, text)) {
          if (areaByKey.get(key) !== "agents_chat") leaks.push(`${reader}: «${text}» → ${key}`);
        }
      }
    }

    expect(leaks).toEqual([]);
  }, EVAL_MEASUREMENT_TIMEOUT_MILLISECONDS);

  it("measures retrieval in the group and pins the result", async () => {
    const evaluated: EvaluatedGroupQuery[] = [];
    for (const query of MEMORY_RETRIEVAL_EVAL_GROUP_QUERIES) {
      const resultKeys = await search(readers.get("agents_chat")!, query.text);
      evaluated.push({
        foundExpectedKeys: query.expectedKeys.filter((key) => resultKeys.includes(key)),
        hit: query.expectedKeys.length === 0
          ? resultKeys.length === 0
          : query.expectedKeys.some((key) => resultKeys.includes(key)),
        query,
        resultKeys,
        topPositionHit: query.expectedKeys.some((key) => resultKeys.slice(0, EVAL_TOP_POSITIONS).includes(key)),
      });
    }

    const positive = evaluated.filter((entry) => !EMPTY_CATEGORIES.includes(entry.query.category));
    const smallTalk = evaluated.filter((entry) => entry.query.category === "small_talk");
    const metrics = {
      aliasWordingRecallAt12: rateOf(evaluated, "alias_wording", (entry) => entry.hit),
      aliasWordingTopThreeRate: rateOf(evaluated, "alias_wording", (entry) => entry.topPositionHit),
      botPersonaRecallAt12: rateOf(evaluated, "bot_persona", (entry) => entry.hit),
      expectedInTopThreeRate: share(positive.filter((entry) => entry.topPositionHit).length, positive.length),
      linkRecallAt12: rateOf(evaluated, "link_request", (entry) => entry.hit),
      // The person is not in memory with this topic, a neighbour is: silence is the right answer.
      participantNearMissEmptyRate: rateOf(evaluated, "participant_near_miss", (entry) => entry.hit),
      // The harm silence would prevent: a neighbour's record on the topic among the first three,
      // where the model takes it for what the person asked about said (#343).
      participantNearMissNeighbourTopThreeRate: rateOf(evaluated, "participant_near_miss", (entry) =>
        entry.resultKeys.slice(0, EVAL_TOP_POSITIONS).some((key) => {
          const label = subjectByKey.get(key) ?? "";
          const handle = /\(@?([A-Za-z0-9_]{3,})\)$/u.exec(label)?.[1];
          return handle !== undefined && handle !== entry.query.askedAbout;
        })),
      participantRecallAt12: rateOf(evaluated, "participant_fact", (entry) => entry.hit),
      participantTopThreeRate: rateOf(evaluated, "participant_fact", (entry) => entry.topPositionHit),
      positiveRecallAt12: share(positive.filter((entry) => entry.hit).length, positive.length),
      smallTalkEmptyRate: rateOf(evaluated, "small_talk", (entry) => entry.hit),
      // How much a reaction costs the model's context when the selection does not stay empty.
      smallTalkMeanOffered: share(smallTalk.reduce((total, entry) => total + entry.resultKeys.length, 0), smallTalk.length),
      topicFullCoverageRate: rateOf(evaluated, "topic_any",
        (entry) => entry.foundExpectedKeys.length === entry.query.expectedKeys.length),
      topicRecallAt12: rateOf(evaluated, "topic_any", (entry) => entry.hit),
    };
    console.info("MEMORY_RETRIEVAL_EVAL_GROUP", JSON.stringify({
      evaluated,
      metrics,
      version: MEMORY_RETRIEVAL_EVAL_GROUP_FIXTURE_VERSION,
    }));

    expect(metrics).toEqual(MEMORY_RETRIEVAL_EVAL_GROUP_BASELINE);
  }, EVAL_MEASUREMENT_TIMEOUT_MILLISECONDS);
});
