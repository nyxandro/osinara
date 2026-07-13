/**
 * Durable Telegram HITL approval repository integration tests.
 *
 * Constructs covered:
 * - `telegramHitlApprovalRepository.register`: binds a rendered request to one Telegram user.
 * - `claimCallback`: atomically rejects foreign, stale, and repeated callback attempts.
 * - Pending approvals survive the Eve turn that pauses for user input.
 * - `authorizeReply`: atomically protects and consumes accepted text replies.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { telegramHitlApprovalRepository } from "./approval-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;
const OWNER_TELEGRAM_ID = "hitl-owner";

async function fixture() {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('HITL') RETURNING id",
  );
  const owner = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ($1, 'Владелец') RETURNING id`,
    [OWNER_TELEGRAM_ID],
  );
  await database().query(
    `INSERT INTO family_memberships (family_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [family.rows[0]!.id, owner.rows[0]!.id],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-1001', 'Семья', 'family_private', 'addressed_only')
     RETURNING id`,
    [family.rows[0]!.id],
  );
  const session = await sessionRepository.prepareTurn({
    baseContinuationToken: "-1001:55:77",
    familyId: family.rows[0]!.id,
    groupId: group.rows[0]!.id,
    now: new Date("2026-07-13T12:00:00.000Z"),
    scope: "family",
    userId: null,
  });
  await sessionRepository.bindEveSession(session.id, "wrun_hitl");
  await sessionRepository.markPendingOperation(session.id, true);
  await sessionRepository.registerRoute(session.id, "-1001:55:88");
  await telegramHitlApprovalRepository.register({
    applicationSessionId: session.id,
    callbackData: ["eve:0", "eve:1"],
    eveSessionId: "wrun_hitl",
    requestId: "approval-request-1",
    telegramChatId: "-1001",
    telegramChatType: "supergroup",
    telegramMessageId: "88",
    telegramMessageThreadId: "55",
    telegramUserId: OWNER_TELEGRAM_ID,
  });
  return { ownerId: owner.rows[0]!.id, sessionId: session.id };
}

describeWithDatabase("Telegram HITL approval repository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE telegram_hitl_approvals, conversation_session_routes, conversation_sessions, telegram_groups, family_memberships, users, families CASCADE",
    );
  });
  afterAll(async () => closeDatabase());

  it("rejects another group member without consuming the initiator's approval", async () => {
    const current = await fixture();

    await expect(telegramHitlApprovalRepository.claimCallback({
      baseContinuationToken: "-1001:55:88",
      callbackData: "eve:0",
      telegramChatId: "-1001",
      telegramMessageId: "88",
      telegramUserId: "202",
    })).resolves.toEqual({ status: "forbidden" });

    await expect(telegramHitlApprovalRepository.claimCallback({
      baseContinuationToken: "-1001:55:88",
      callbackData: "eve:0",
      telegramChatId: "-1001",
      telegramMessageId: "88",
      telegramUserId: OWNER_TELEGRAM_ID,
    })).resolves.toMatchObject({
      auth: {
        attributes: {
          applicationSessionId: current.sessionId,
          familyId: expect.any(String),
          groupId: expect.any(String),
          groupType: "family_private",
          memoryScopes: ["family"],
          role: "owner",
          telegramUserId: OWNER_TELEGRAM_ID,
        },
        authenticator: "telegram",
        principalId: current.ownerId,
        principalType: "user",
      },
      status: "authorized",
    });
  });

  it("expires a callback after its first atomic claim", async () => {
    const current = await fixture();
    const input = {
      callbackData: "eve:1",
      baseContinuationToken: "-1001:55:88",
      telegramChatId: "-1001",
      telegramMessageId: "88",
      telegramUserId: OWNER_TELEGRAM_ID,
    };

    await expect(telegramHitlApprovalRepository.claimCallback(input))
      .resolves.toMatchObject({ status: "authorized" });
    await expect(telegramHitlApprovalRepository.claimCallback(input))
      .resolves.toEqual({ status: "expired" });
  });

  it("keeps a callback claimable after the Eve turn pauses for approval", async () => {
    const current = await fixture();

    await expect(telegramHitlApprovalRepository.hasPendingForSession(
      current.sessionId,
      "wrun_hitl",
    )).resolves.toBe(true);
    await expect(sessionRepository.recordTurnCompleted(
      current.sessionId,
      "wrun_hitl",
      true,
    )).resolves.toBe("recorded");
    await expect(telegramHitlApprovalRepository.claimCallback({
      baseContinuationToken: "-1001:55:88",
      callbackData: "eve:0",
      telegramChatId: "-1001",
      telegramMessageId: "88",
      telegramUserId: OWNER_TELEGRAM_ID,
    })).resolves.toMatchObject({ status: "authorized" });
    await expect(telegramHitlApprovalRepository.hasPendingForSession(
      current.sessionId,
      "wrun_hitl",
    )).resolves.toBe(false);
  });

  it("keeps other simultaneously rendered requests pending", async () => {
    const current = await fixture();
    await sessionRepository.registerRoute(current.sessionId, "-1001:55:89");
    await telegramHitlApprovalRepository.register({
      applicationSessionId: current.sessionId,
      callbackData: ["eve:2", "eve:3"],
      eveSessionId: "wrun_hitl",
      requestId: "approval-request-2",
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
      telegramMessageId: "89",
      telegramMessageThreadId: "55",
      telegramUserId: OWNER_TELEGRAM_ID,
    });

    await expect(telegramHitlApprovalRepository.claimCallback({
      baseContinuationToken: "-1001:55:88",
      callbackData: "eve:0",
      telegramChatId: "-1001",
      telegramMessageId: "88",
      telegramUserId: OWNER_TELEGRAM_ID,
    })).resolves.toMatchObject({ status: "authorized" });
    await expect(telegramHitlApprovalRepository.claimCallback({
      baseContinuationToken: "-1001:55:89",
      callbackData: "eve:2",
      telegramChatId: "-1001",
      telegramMessageId: "89",
      telegramUserId: OWNER_TELEGRAM_ID,
    })).resolves.toMatchObject({ status: "authorized" });
  });

  it("clears only approvals owned by the completed Eve root", async () => {
    const current = await fixture();
    await telegramHitlApprovalRepository.register({
      applicationSessionId: current.sessionId,
      callbackData: ["eve:2"],
      eveSessionId: "wrun_hitl_new",
      requestId: "approval-request-new-root",
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
      telegramMessageId: "90",
      telegramMessageThreadId: "55",
      telegramUserId: OWNER_TELEGRAM_ID,
    });

    await telegramHitlApprovalRepository.clearForEveSession(current.sessionId, "wrun_hitl");

    await expect(database().query<{ eve_session_id: string }>(
      "SELECT eve_session_id FROM telegram_hitl_approvals WHERE application_session_id = $1",
      [current.sessionId],
    )).resolves.toMatchObject({ rows: [{ eve_session_id: "wrun_hitl_new" }] });
  });

  it("rechecks active family membership before resuming Eve", async () => {
    const current = await fixture();
    await database().query("DELETE FROM family_memberships WHERE user_id = $1", [current.ownerId]);

    await expect(telegramHitlApprovalRepository.claimCallback({
      baseContinuationToken: "-1001:55:88",
      callbackData: "eve:0",
      telegramChatId: "-1001",
      telegramMessageId: "88",
      telegramUserId: OWNER_TELEGRAM_ID,
    })).resolves.toEqual({ status: "forbidden" });
  });

  it("protects and atomically consumes a text reply from the expected identity", async () => {
    await fixture();

    await expect(telegramHitlApprovalRepository.authorizeReply({
      baseContinuationToken: "-1001:55:88",
      telegramChatId: "-1001",
      telegramMessageId: "88",
      telegramUserId: "202",
    })).resolves.toBe("forbidden");
    await expect(telegramHitlApprovalRepository.authorizeReply({
      baseContinuationToken: "-1001:55:88",
      telegramChatId: "-1001",
      telegramMessageId: "88",
      telegramUserId: OWNER_TELEGRAM_ID,
    })).resolves.toBe("authorized");
    await expect(telegramHitlApprovalRepository.authorizeReply({
      baseContinuationToken: "-1001:55:88",
      telegramChatId: "-1001",
      telegramMessageId: "88",
      telegramUserId: OWNER_TELEGRAM_ID,
    })).resolves.toBe("expired");
    await expect(telegramHitlApprovalRepository.authorizeReply({
      baseContinuationToken: "-1001:55:999",
      telegramChatId: "-1001",
      telegramMessageId: "999",
      telegramUserId: OWNER_TELEGRAM_ID,
    })).resolves.toBe("not_applicable");
  });

  it("expires a reply through another route alias while the session awaits approval", async () => {
    await fixture();

    await expect(telegramHitlApprovalRepository.authorizeReply({
      baseContinuationToken: "-1001:55:77",
      telegramChatId: "-1001",
      telegramMessageId: "77",
      telegramUserId: "202",
    })).resolves.toBe("expired");
  });

  it("fails closed when the route is pending but approval registration is missing", async () => {
    await fixture();
    await database().query("DELETE FROM telegram_hitl_approvals");

    await expect(telegramHitlApprovalRepository.authorizeReply({
      baseContinuationToken: "-1001:55:77",
      telegramChatId: "-1001",
      telegramMessageId: "77",
      telegramUserId: "202",
    })).resolves.toBe("expired");
  });
});
