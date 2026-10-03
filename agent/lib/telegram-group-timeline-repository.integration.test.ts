/**
 * Unified Telegram group timeline PostgreSQL integration tests.
 *
 * Constructs covered:
 * - Group-wide monotonic sequence allocation across user and agent entries.
 * - Every delivered agent chunk resolves to one logical entry and trusted replies.
 * - Tool-delivered agent attachments persist without an inbound Telegram file identifier.
 * - Retention never resets or reuses the durable group counter.
 */
import type { TelegramMessage } from "../runtime/telegram/inbound.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { telegramGroupJournalRepository as productionTelegramGroupJournalRepository } from "./telegram-group-journal-repository.js";
import { recordVerifiedHumanTelegramMessage } from "./telegram-group-journal.integration-fixtures.js";
import { sessionRepository } from "./sessions/session-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

// Existing timeline tests use only verified human fixtures; retain agent-response operations while
// routing inbound writes through the actor-validating test boundary.
const telegramGroupJournalRepository = {
  ...productionTelegramGroupJournalRepository,
  record: recordVerifiedHumanTelegramMessage,
};

function message(id: string, replyToMessageId?: string): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: "-1001", title: "Группа", type: "supergroup" },
    from: { firstName: "Анна", id: "101", isBot: false },
    messageId: id,
    raw: { date: 1_700_000_000 + Number(id) },
    ...(replyToMessageId === undefined ? {} : {
      replyToMessage: {
        chat: { id: "-1001", title: "Группа", type: "supergroup" },
        messageId: replyToMessageId,
      },
    }),
    text: `message-${id}`,
  };
}

async function group(telegramChatId = "-1001"): Promise<string> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Timeline') RETURNING id",
  );
  const result = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, tool_allowlist, message_mode)
      VALUES ($1, $2, 'Группа', 'family_private', '{}', 'all') RETURNING id`,
    [family.rows[0]!.id, telegramChatId],
  );
  return result.rows[0]!.id;
}

describeWithDatabase("unified Telegram group timeline repository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE telegram_group_message_ids, telegram_group_messages, telegram_groups, families CASCADE",
    );
  });

  afterAll(closeDatabase);

  it("allocates one sequence and maps all agent chunks to its reply target", async () => {
    const groupId = await group();
    const inbound = await telegramGroupJournalRepository.record(groupId, message("10"));
    expect(inbound).toMatchObject({ status: "inserted", sequenceId: "1" });

    const agent = await telegramGroupJournalRepository.recordAgentResponse({
      applicationSessionId: null,
      contentText: "Финальный ответ",
      deliveredAt: new Date("2026-07-28T10:01:00.000Z"),
      groupId,
      messageThreadId: null,
      replyToEntryId: inbound.entryId,
      telegramMessageIds: ["20", "21"],
    });
    expect(agent.sequenceId).toBe("2");
    const replay = await telegramGroupJournalRepository.recordAgentResponse({
      applicationSessionId: null,
      contentText: "Финальный ответ",
      deliveredAt: new Date("2026-07-28T10:01:00.000Z"),
      groupId,
      messageThreadId: null,
      replyToEntryId: inbound.entryId,
      telegramMessageIds: ["20", "21"],
    });
    expect(replay).toEqual(agent);

    const reply = await telegramGroupJournalRepository.record(groupId, message("30", "21"));
    expect(reply.sequenceId).toBe("3");
    expect(reply.replyToAgent).toBe(true);
    const entries = await telegramGroupJournalRepository.listRecent({
      anchorEntryId: null, beforeSequence: null, groupId, limit: 50, messageThreadId: null,
    });
    expect(entries.map((entry) => [entry.sequenceId, entry.actorKind, entry.replyToSequenceId]))
      .toEqual([["1", "user", null], ["2", "agent_self", "1"], ["3", "user", "2"]]);
  });

  it("records an agent-delivered attachment without an inbound Telegram file ID", async () => {
    const groupId = await group();

    const result = await telegramGroupJournalRepository.recordAgentResponse({
      applicationSessionId: null,
      attachment: {
        fileName: "report.pdf",
        kind: "document",
        mediaType: "application/pdf",
        size: 1_024,
      },
      contentText: "Финансовый отчёт",
      deliveredAt: new Date("2026-07-31T10:00:00.000Z"),
      groupId,
      messageThreadId: null,
      replyToEntryId: null,
      telegramMessageIds: ["40"],
    });

    const stored = await database().query<{
      actor_kind: string;
      attachment_file_id: string | null;
      attachment_file_name: string | null;
      attachment_kind: string | null;
      attachment_media_type: string | null;
      attachment_size: string | null;
    }>(
      `SELECT actor_kind, attachment_file_id, attachment_file_name, attachment_kind,
              attachment_media_type, attachment_size::text
       FROM telegram_group_messages WHERE id = $1`,
      [result.entryId],
    );
    expect(stored.rows[0]).toEqual({
      actor_kind: "agent_self",
      attachment_file_id: null,
      attachment_file_name: "report.pdf",
      attachment_kind: "document",
      attachment_media_type: "application/pdf",
      attachment_size: "1024",
    });
  });

  it("does not reset the sequence after physical pruning", async () => {
    const groupId = await group();
    await database().query("UPDATE telegram_groups SET next_timeline_sequence = 1000 WHERE id = $1", [groupId]);

    const result = await telegramGroupJournalRepository.record(groupId, message("1001"));

    expect(result.sequenceId).toBe("1001");
  });

  it("does not attach an agent response to an entry from another group", async () => {
    const firstGroupId = await group("-1001");
    const secondGroupId = await group("-1002");
    const foreign = await telegramGroupJournalRepository.record(firstGroupId, message("10"));

    await telegramGroupJournalRepository.recordAgentResponse({
      applicationSessionId: null,
      contentText: "Ответ во второй группе",
      deliveredAt: new Date("2026-07-28T10:01:00.000Z"),
      groupId: secondGroupId,
      messageThreadId: null,
      replyToEntryId: foreign.entryId,
      telegramMessageIds: ["20"],
    });

    const entries = await telegramGroupJournalRepository.listRecent({
      anchorEntryId: null,
      beforeSequence: null,
      groupId: secondGroupId,
      limit: 50,
      messageThreadId: null,
    });
    expect(entries[0]?.replyToSequenceId).toBeNull();
  });

  it("retains the stable reply sequence when retention deletes the target entry", async () => {
    const groupId = await group();
    const inbound = await telegramGroupJournalRepository.record(groupId, message("10"));
    const agent = await telegramGroupJournalRepository.recordAgentResponse({
      applicationSessionId: null,
      contentText: "Ответ",
      deliveredAt: new Date("2026-07-28T10:01:00.000Z"),
      groupId,
      messageThreadId: null,
      replyToEntryId: inbound.entryId,
      telegramMessageIds: ["20"],
    });

    await database().query("DELETE FROM telegram_group_messages WHERE id = $1", [inbound.entryId]);
    const retained = await database().query<{
      reply_to_entry_id: string | null;
      reply_to_sequence_id: string | null;
    }>(
      `SELECT reply_to_entry_id, reply_to_sequence_id::text
       FROM telegram_group_messages WHERE id = $1`,
      [agent.entryId],
    );
    expect(retained.rows[0]).toEqual({ reply_to_entry_id: null, reply_to_sequence_id: "1" });
  });

  it("returns only unseen entries not owned by the current application session", async () => {
    const groupId = await group();
    const groupRow = await database().query<{ family_id: string }>(
      "SELECT family_id FROM telegram_groups WHERE id = $1",
      [groupId],
    );
    const session = await sessionRepository.prepareTurn({
      baseContinuationToken: "-1001::10",
      kind: "canonical",
      telegramForumTopicId: null,
      familyId: groupRow.rows[0]!.family_id,
      groupId,
      now: new Date("2026-07-30T12:00:00.000Z"),
      scope: "family",
      userId: null,
    });
    const first = await telegramGroupJournalRepository.record(groupId, message("10"));
    await telegramGroupJournalRepository.recordAgentResponse({
      applicationSessionId: session.id,
      contentText: "Собственный ответ",
      deliveredAt: new Date("2026-07-30T12:01:00.000Z"),
      groupId,
      messageThreadId: null,
      replyToEntryId: first.entryId,
      telegramMessageIds: ["11"],
    });
    await telegramGroupJournalRepository.record(groupId, message("12"));
    await telegramGroupJournalRepository.recordAgentResponse({
      applicationSessionId: null,
      contentText: "Ответ другой ветки",
      deliveredAt: new Date("2026-07-30T12:02:00.000Z"),
      groupId,
      messageThreadId: null,
      replyToEntryId: null,
      telegramMessageIds: ["13"],
    });
    const current = await telegramGroupJournalRepository.record(groupId, message("14"));

    const page = await telegramGroupJournalRepository.listIncremental({
      afterSequence: first.sequenceId,
      anchorEntryId: current.entryId,
      applicationSessionId: session.id,
      beforeSequence: current.sequenceId,
      groupId,
      limit: 50,
      messageThreadId: null,
    });

    expect(page.omittedBeforeSequence).toBeNull();
    expect(page.entries.map((entry) => [entry.telegramMessageId, entry.actorKind]))
      .toEqual([["12", "user"], ["13", "agent_self"]]);
  });

  it("marks an incremental gap when unseen history exceeds the context limit", async () => {
    const groupId = await group();
    const groupRow = await database().query<{ family_id: string }>(
      "SELECT family_id FROM telegram_groups WHERE id = $1",
      [groupId],
    );
    const session = await sessionRepository.prepareTurn({
      baseContinuationToken: "-1001::20",
      kind: "canonical",
      telegramForumTopicId: null,
      familyId: groupRow.rows[0]!.family_id,
      groupId,
      now: new Date("2026-07-30T12:00:00.000Z"),
      scope: "family",
      userId: null,
    });
    const first = await telegramGroupJournalRepository.record(groupId, message("20"));
    await telegramGroupJournalRepository.record(groupId, message("21"));
    await telegramGroupJournalRepository.record(groupId, message("22"));
    const current = await telegramGroupJournalRepository.record(groupId, message("23"));

    const page = await telegramGroupJournalRepository.listIncremental({
      afterSequence: first.sequenceId,
      anchorEntryId: current.entryId,
      applicationSessionId: session.id,
      beforeSequence: current.sequenceId,
      groupId,
      limit: 1,
      messageThreadId: null,
    });

    expect(page.entries.map((entry) => entry.telegramMessageId)).toEqual(["22"]);
    expect(page.omittedBeforeSequence).toBe(page.entries[0]?.sequenceId);
  });

  it("loads unseen reply ancestry without crossing a forum topic boundary", async () => {
    const groupId = await group();
    const groupRow = await database().query<{ family_id: string }>(
      "SELECT family_id FROM telegram_groups WHERE id = $1",
      [groupId],
    );
    const session = await sessionRepository.prepareTurn({
      baseContinuationToken: "-1001:42:30",
      kind: "canonical",
      telegramForumTopicId: null,
      familyId: groupRow.rows[0]!.family_id,
      groupId,
      now: new Date("2026-07-30T12:00:00.000Z"),
      scope: "family",
      userId: null,
    });
    const topicMessage = (id: string, threadId: number, replyId?: string): TelegramMessage => ({
      ...message(id, replyId),
      messageThreadId: threadId,
      raw: { date: 1_700_000_000 + Number(id), is_topic_message: true },
    });
    const sameTopicParent = await telegramGroupJournalRepository.record(
      groupId,
      topicMessage("30", 42),
    );
    const cursor = await telegramGroupJournalRepository.record(groupId, topicMessage("31", 42));
    await telegramGroupJournalRepository.record(groupId, topicMessage("32", 42, "30"));
    const foreignParent = await telegramGroupJournalRepository.record(
      groupId,
      topicMessage("40", 84),
    );
    await telegramGroupJournalRepository.record(groupId, topicMessage("33", 42, "40"));
    const current = await telegramGroupJournalRepository.record(groupId, topicMessage("34", 42));

    const page = await telegramGroupJournalRepository.listIncremental({
      afterSequence: cursor.sequenceId,
      anchorEntryId: current.entryId,
      applicationSessionId: session.id,
      beforeSequence: current.sequenceId,
      groupId,
      limit: 50,
      messageThreadId: "42",
    });

    expect(page.entries.map((entry) => entry.telegramMessageId)).toEqual(["30", "32", "33"]);
    expect(page.entries.map((entry) => entry.telegramMessageId)).not.toContain("40");
    expect(sameTopicParent.sequenceId).not.toBe(foreignParent.sequenceId);
  });
});
