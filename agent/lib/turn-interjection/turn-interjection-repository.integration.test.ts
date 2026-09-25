/**
 * PostgreSQL turn interjection repository integration tests.
 *
 * Constructs covered:
 * - Candidates are waiting messages after the running update, in the same chat queue, from the same
 *   sender only; album members and messages owned by another tool call are left out.
 * - A message belongs to the first tool call that claims it; a retry of that call keeps it until a
 *   model step had it in its prompt.
 * - Only a returned and then delivered claim is reported to the ordinary turn, and only to the same
 *   conversation; a released claim is free for a later call.
 * - Voice follows the ordinary path's paid-call rule, and the ordinary claim reuses the transcript.
 * - The canonical route resolves to the live session it leads to; a reply into a conversation that
 *   awaits a confirmation is recognized.
 * - A re-claim by the same call clears a stale returned mark from an earlier attempt.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { telegramIngressRepository } from "../telegram-ingress-repository.js";
import { turnInterjectionRepository } from "./turn-interjection-repository.js";
import { NO_BURSTS } from "../telegram-ingress.test-fixtures.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;
const LEASE_MILLISECONDS = 60_000;

if (integrationTestsEnabled) {
  if (!integrationDatabaseUrl) {
    throw new Error("AGENT_TEST_DATABASE_CONFIG_MISSING: Для integration-тестов не задан DATABASE_URL");
  }
  if (!new URL(integrationDatabaseUrl).pathname.slice(1).endsWith("_test")) {
    throw new Error("AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test");
  }
}

const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;
const COORDINATE = { eveSessionId: "ses_1", eveTurnId: "turn_2", toolCallId: "call-1" };
const OTHER_CALL = { ...COORDINATE, toolCallId: "call-2" };

async function enqueue(updateId: string, input: { chatId?: string; fromId?: number; text?: string; voice?: boolean } = {}) {
  const chatId = input.chatId ?? "101";
  await telegramIngressRepository.enqueue({
    continuationKey: `${chatId}::`,
    payload: {
      message: {
        chat: { id: Number(chatId), type: "private" },
        from: { id: input.fromId ?? 101, is_bot: false },
        message_id: Number(updateId),
        ...(input.voice ? { voice: { file_id: `voice-${updateId}` } } : { text: input.text ?? `text ${updateId}` }),
      },
      update_id: Number(updateId),
    },
    updateId,
    ...(input.voice ? { voice: { fileId: `voice-${updateId}` } } : {}),
  });
}

async function conversation(): Promise<string> {
  const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Встраивание') RETURNING id");
  const user = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('101', 'Владелец') RETURNING id",
  );
  await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [
    family.rows[0]!.id,
    user.rows[0]!.id,
  ]);
  const session = await sessionRepository.prepareTurn({
    baseContinuationToken: "101::",
    familyId: family.rows[0]!.id,
    groupId: null,
    kind: "canonical",
    now: new Date(),
    scope: "personal",
    telegramForumTopicId: null,
    userId: user.rows[0]!.id,
  });
  return session.id;
}

describeWithDatabase("turnInterjectionRepository", () => {
  let applicationSessionId: string;
  let call: typeof COORDINATE & { applicationSessionId: string };

  async function list(coordinate = COORDINATE) {
    return await turnInterjectionRepository.listCandidates({
      ...coordinate,
      currentUpdateId: "1000",
      limit: 10,
      telegramUserId: "101",
    });
  }

  beforeEach(async () => {
    await database().query(
      `TRUNCATE telegram_turn_interjections, eve_session_event_cursors, telegram_ingress_ignored_updates,
         telegram_ingress_updates, telegram_ingress_continuation_aliases, telegram_ingress_queues,
         conversation_session_routes, conversation_sessions, conversation_route_generations,
         family_memberships, users, families CASCADE`,
    );
    applicationSessionId = await conversation();
    call = { ...COORDINATE, applicationSessionId };
    await enqueue("1000", { text: "собери отчёт" });
    expect((await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS))?.updateId).toBe("1000");
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("lists only later waiting messages of the same sender in the same queue", async () => {
    await enqueue("1001", { text: "стоп, Питер" });
    await enqueue("1002", { fromId: 202, text: "чужое" });
    await enqueue("1003", { chatId: "303", fromId: 101, text: "другой чат" });
    await enqueue("1004", { text: "альбом" });
    await enqueue("1005", { text: "часть альбома" });
    await database().query(
      "UPDATE telegram_ingress_updates SET media_group_key = 'album-1', media_group_ready_at = now() WHERE update_id = 1004",
    );
    await database().query("UPDATE telegram_ingress_updates SET media_group_leader_id = 1004 WHERE update_id = 1005");

    const candidates = await list();

    expect(candidates.map((candidate) => candidate.updateId)).toEqual(["1001", "1004"]);
    expect(candidates[1]).toMatchObject({ albumMemberCount: 1, voice: null, voiceTranscript: null });
  });

  it("resolves the chat's canonical route to its live conversation", async () => {
    expect(await turnInterjectionRepository.routeSessionId("101::")).toBe(applicationSessionId);
    expect(await turnInterjectionRepository.routeSessionId("101:77:")).toBeNull();
  });

  it("recognizes a reply into a conversation that awaits a confirmation", async () => {
    expect(await turnInterjectionRepository.isReplyToPendingConfirmation({
      replyMessageId: "77", replyRouteToken: "101::77", telegramChatId: "101",
    })).toBe(false);

    await database().query(
      "INSERT INTO conversation_session_routes (base_continuation_token, session_id) VALUES ('101::77', $1)",
      [applicationSessionId],
    );
    await database().query("UPDATE conversation_sessions SET pending_operation = true WHERE id = $1", [applicationSessionId]);

    expect(await turnInterjectionRepository.isReplyToPendingConfirmation({
      replyMessageId: "77", replyRouteToken: "101::77", telegramChatId: "101",
    })).toBe(true);
  });

  it("clears a stale returned mark when the same call claims again", async () => {
    await enqueue("1001");
    await turnInterjectionRepository.claim(call, [{ contentKind: "text", updateId: "1001" }]);
    await turnInterjectionRepository.markReturned(COORDINATE, ["1001"]);
    await turnInterjectionRepository.claim(call, [{ contentKind: "notice", updateId: "1001" }]);

    expect(await turnInterjectionRepository.markDelivered("ses_1", "turn_2")).toBe(0);
  });

  it("gives a message to one tool call and reports it only after a model step saw it", async () => {
    await enqueue("1001");

    expect(await turnInterjectionRepository.claim(call, [{ contentKind: "text", updateId: "1001" }])).toEqual(new Set(["1001"]));
    expect(await turnInterjectionRepository.claim({ ...OTHER_CALL, applicationSessionId }, [{ contentKind: "text", updateId: "1001" }]))
      .toEqual(new Set());
    expect((await list(OTHER_CALL)).map((candidate) => candidate.updateId)).toEqual([]);
    expect((await list()).map((candidate) => candidate.updateId)).toEqual(["1001"]);

    expect(await turnInterjectionRepository.markDelivered("ses_1", "turn_2")).toBe(0);
    await turnInterjectionRepository.markReturned(COORDINATE, ["1001"]);
    expect(await turnInterjectionRepository.findDeliveredContentKind("1001", applicationSessionId)).toBeNull();
    expect(await turnInterjectionRepository.markDelivered("ses_1", "turn_2")).toBe(1);

    expect(await turnInterjectionRepository.findDeliveredContentKind("1001", applicationSessionId)).toBe("text");
    expect(await turnInterjectionRepository.findDeliveredContentKind("1001", "00000000-0000-4000-8000-0000000000ff")).toBeNull();
    // A later step's call that happens to reuse the call id is not a retry of a delivered result.
    expect((await list()).map((candidate) => candidate.updateId)).toEqual([]);
  });

  it("frees a released claim for a later call and never claims a message that left the queue", async () => {
    await enqueue("1001");
    await turnInterjectionRepository.claim(call, [{ contentKind: "text", updateId: "1001" }]);
    await turnInterjectionRepository.releaseCall(COORDINATE);

    expect((await list(OTHER_CALL)).map((candidate) => candidate.updateId)).toEqual(["1001"]);
    expect(await turnInterjectionRepository.claim(call, [{ contentKind: "text", updateId: "1000" }])).toEqual(new Set());
  });

  it("marks a paid transcription as started and lets the ordinary claim reuse the transcript", async () => {
    await enqueue("1001", { voice: true });
    await enqueue("1002", { voice: true });
    expect((await list())[0]).toMatchObject({ voice: { fileId: "voice-1001" }, voiceTranscript: null });

    expect(await turnInterjectionRepository.beginEarlyVoiceTranscription("1001")).toEqual({ status: "started" });
    expect(await turnInterjectionRepository.beginEarlyVoiceTranscription("1001")).toEqual({ status: "unavailable" });
    expect(await turnInterjectionRepository.saveEarlyVoiceTranscript("1001", " добавь цены ")).toBe("добавь цены");
    expect(await turnInterjectionRepository.beginEarlyVoiceTranscription("1001"))
      .toEqual({ status: "transcribed", transcript: "добавь цены" });
    // A transcript can only follow a started call, exactly as on the ordinary path.
    expect(await turnInterjectionRepository.saveEarlyVoiceTranscript("1002", "без начала")).toBeNull();

    const current = await database().query<{ lease_token: string }>(
      "SELECT lease_token::text FROM telegram_ingress_updates WHERE update_id = 1000",
    );
    await telegramIngressRepository.complete("1000", current.rows[0]!.lease_token);
    const voice = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS);
    expect(voice).toMatchObject({ transcript: "добавь цены", updateId: "1001" });
    expect(await telegramIngressRepository.beginVoiceTranscription("1001", voice!.leaseToken)).toBe("completed");
  });
});
