/**
 * Durable Telegram HITL approval repository integration tests.
 *
 * Constructs covered:
 * - `telegramHitlApprovalRepository.register`: binds a rendered request to one Telegram user.
 * - `claimCallback`: atomically rejects foreign, stale, and repeated callback attempts.
 * - Pending approvals survive the Eve turn that pauses for user input.
 * - `authorizeReply`: atomically protects and consumes accepted text replies.
 * - Consumed prompts become ordinary ancestry for any later author without weakening pending binds.
 * - Owner-only external approvals recheck the current owner role before resuming Eve.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { telegramHitlApprovalRepository } from "./approval-repository.js";
import { telegramIngressRepository } from "../telegram-ingress-repository.js";
import { bindTelegramIngressTurn } from "../telegram-ingress-binding.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;
const OWNER_TELEGRAM_ID = "hitl-owner";

async function fixture(
  options: {
    freeform?: boolean;
    messageMode?: "addressed_only" | "owner_only";
    scope?: "family" | "group";
    type?: "external" | "family_private";
  } = {},
) {
  const groupType = options.type ?? "family_private";
  const messageMode = options.messageMode ?? "addressed_only";
  const scope = options.scope ?? "family";
  const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('HITL') RETURNING id");
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
     VALUES ($1, '-1001', 'Семья', $2, $3)
      RETURNING id`,
    [family.rows[0]!.id, groupType, messageMode],
  );
  const session = await sessionRepository.prepareTurn({
    baseContinuationToken: "-1001:55:77",
    kind: "canonical",
    telegramForumTopicId: null,
    familyId: family.rows[0]!.id,
    groupId: group.rows[0]!.id,
    now: new Date("2026-07-13T12:00:00.000Z"),
    scope,
    userId: null,
  });
  await sessionRepository.bindEveSession(session.id, "wrun_hitl");
  await sessionRepository.parkSession({
    applicationSessionId: session.id,
    pendingRequestId: "approval-request-1",
    requesterTelegramUserId: OWNER_TELEGRAM_ID,
    requesterUserId: owner.rows[0]!.id,
  });
  await sessionRepository.registerRouteAlias(session.id, "-1001:55:88");
  await telegramHitlApprovalRepository.register({
    applicationSessionId: session.id,
    kind: options.freeform ? "question" : "tool-approval",
    callbackData: options.freeform ? [] : ["eve:0", "eve:1"],
    callbackOptions: options.freeform ? [] : [
      { callbackData: "eve:0", label: "Да, подтвердить", optionId: "approve" },
      { callbackData: "eve:1", label: "Нет, отклонить", optionId: "deny" },
    ],
    eveSessionId: "wrun_hitl",
    eveTurnId: "turn_0",
    requestId: "approval-request-1",
    promptText: "Подтвердите тестовое действие",
    telegramChatId: "-1001",
    telegramChatType: "supergroup",
    telegramMessageId: "88",
    telegramMessageThreadId: "55",
    telegramUserId: OWNER_TELEGRAM_ID,
    toolCallId: "call-1",
    toolInputHash: "a".repeat(64),
    toolName: "test_tool",
  });
  return { ownerId: owner.rows[0]!.id, sessionId: session.id };
}

describeWithDatabase("Telegram HITL approval repository", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE telegram_hitl_approvals, conversation_session_routes, conversation_sessions, telegram_groups, family_memberships, users, families CASCADE");
  });
  afterAll(async () => closeDatabase());

  it("atomically binds a consumed callback and permits recovery only for its identical verified update", async () => {
    await fixture();
    await database().query("TRUNCATE telegram_ingress_queues CASCADE");
    await telegramIngressRepository.enqueue({ updateId: "900", continuationKey: "-1001:55:", payload: { update_id: 900,
      callback_query: { id: "callback-900", data: "eve:0", from: { id: OWNER_TELEGRAM_ID } } } });
    const claim = (await telegramIngressRepository.claimNext(60000))!;
    const dispatchId = crypto.randomUUID();
    await telegramIngressRepository.beginDispatch(claim.updateId,claim.leaseToken,dispatchId);
    const input = { baseContinuationToken: "-1001:55:88", callbackData: "eve:0", telegramChatId: "-1001",
      telegramMessageId: "88", telegramUserId: OWNER_TELEGRAM_ID,
      ingress: { updateId: "900", dispatchId, callbackQueryId: "callback-900" } };
    expect((await telegramHitlApprovalRepository.claimCallback(input)).status).toBe("authorized");
    expect((await database().query("SELECT response_session_id,response_turn_id,dispatch_turn_id FROM telegram_ingress_updates WHERE update_id=900")).rows)
      .toEqual([{ response_session_id: "wrun_hitl",response_turn_id: "turn_0",dispatch_turn_id: null }]);
    await bindTelegramIngressTurn({ initiator: null,current: { authenticator: "telegram",principalId: OWNER_TELEGRAM_ID,principalType: "user",
      attributes: { osinaraTelegramUpdateId: "900",osinaraTelegramIngressId: dispatchId } } },"wrun_hitl","turn_1");
    expect((await database().query("SELECT response_turn_id,dispatch_turn_id FROM telegram_ingress_updates WHERE update_id=900")).rows)
      .toEqual([{ response_turn_id: "turn_0",dispatch_turn_id: "turn_1" }]);
    expect(await telegramHitlApprovalRepository.claimCallback(input)).toMatchObject({ status: "authorized",replayed: true });
    await expect(telegramHitlApprovalRepository.claimCallback({ ...input,callbackData: "eve:1" }))
      .rejects.toThrow("AGENT_TELEGRAM_CALLBACK_ATTEMPT_STALE");
    expect(await telegramHitlApprovalRepository.claimCallback({ ...input,ingress: { ...input.ingress,callbackQueryId: "another" } }))
      .toEqual({ status: "expired" });
  });
  it("retains the meaning of the same text answer when preparation resumes after consumption", async () => {
    await fixture({ freeform: true });
    await database().query("TRUNCATE telegram_ingress_queues CASCADE");
    await telegramIngressRepository.enqueue({ updateId: "901",continuationKey: "-1001:55:",payload: { update_id: 901,
      message: { message_id: 100,chat: { id: "-1001" },from: { id: OWNER_TELEGRAM_ID },reply_to_message: { message_id: 88 },text: "Да" } } });
    const claim = (await telegramIngressRepository.claimNext(60000))!;
    const dispatchId=crypto.randomUUID();
    await telegramIngressRepository.beginDispatch("901",claim.leaseToken,dispatchId);
    const input = { baseContinuationToken: "-1001:55:88",telegramChatId: "-1001",telegramMessageId: "88",telegramUserId: OWNER_TELEGRAM_ID,
      ingress: { updateId: "901",dispatchId } };
    expect(await telegramHitlApprovalRepository.authorizeReply(input)).toBe("authorized");
    expect(await telegramHitlApprovalRepository.authorizeReply(input)).toBe("authorized");
    expect((await database().query("SELECT response_turn_id FROM telegram_ingress_updates WHERE update_id=901")).rows[0].response_turn_id).toBe("turn_0");
  });

  it("rejects another group member without consuming the initiator's approval", async () => {
    const current = await fixture();

    await expect(
      telegramHitlApprovalRepository.claimCallback({
        baseContinuationToken: "-1001:55:88",
        callbackData: "eve:0",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: "202",
      }),
    ).resolves.toEqual({ status: "forbidden" });

    await expect(
      telegramHitlApprovalRepository.claimCallback({
        baseContinuationToken: "-1001:55:88",
        callbackData: "eve:0",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toMatchObject({
      auth: {
        attributes: {
          applicationSessionId: current.sessionId,
          familyId: expect.any(String),
          groupId: expect.any(String),
          groupType: "family_private",
          memoryScopes: ["family"],
          role: "owner",
          telegramActorId: OWNER_TELEGRAM_ID,
          telegramActorKind: "telegram_user",
          telegramUserId: OWNER_TELEGRAM_ID,
        },
        authenticator: "telegram",
        principalId: current.ownerId,
        principalType: "user",
      },
      promptText: "Подтвердите тестовое действие",
      selectedOptionId: "approve",
      selectedOptionLabel: "Да, подтвердить",
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

    await expect(telegramHitlApprovalRepository.claimCallback(input)).resolves.toMatchObject({
      selectedOptionId: "deny",
      selectedOptionLabel: "Нет, отклонить",
      status: "authorized",
    });
    await expect(telegramHitlApprovalRepository.claimCallback(input)).resolves.toEqual({ status: "expired" });
    await expect(
      telegramHitlApprovalRepository.requireToolExecutionApproval({
        applicationSessionId: current.sessionId,
        eveSessionId: "wrun_hitl",
        telegramUserId: OWNER_TELEGRAM_ID,
        toolCallId: "call-1",
        toolInputHash: "a".repeat(64),
        toolName: "test_tool",
      }),
    ).rejects.toThrowError(/AGENT_TOOL_APPROVAL_EVIDENCE_INVALID/u);
  });

  it("authorizes execution only for the exact consumed identity-bound tool call", async () => {
    const current = await fixture();
    await telegramHitlApprovalRepository.claimCallback({
      baseContinuationToken: "-1001:55:88",
      callbackData: "eve:0",
      telegramChatId: "-1001",
      telegramMessageId: "88",
      telegramUserId: OWNER_TELEGRAM_ID,
    });

    const exact = {
      applicationSessionId: current.sessionId,
      eveSessionId: "wrun_hitl",
      telegramUserId: OWNER_TELEGRAM_ID,
      toolCallId: "call-1",
      toolInputHash: "a".repeat(64),
      toolName: "test_tool",
    };
    await expect(telegramHitlApprovalRepository.requireToolExecutionApproval(exact)).resolves.toBeUndefined();
    await expect(
      telegramHitlApprovalRepository.requireToolExecutionApproval({
        ...exact,
        toolInputHash: "f".repeat(64),
      }),
    ).rejects.toThrowError(/AGENT_TOOL_APPROVAL_EVIDENCE_INVALID/u);
    await expect(
      telegramHitlApprovalRepository.requireToolExecutionApproval({
        ...exact,
        telegramUserId: "202",
      }),
    ).rejects.toThrowError(/AGENT_TOOL_APPROVAL_EVIDENCE_INVALID/u);
  });

  it("keeps a callback claimable after the Eve turn pauses for approval", async () => {
    const current = await fixture();

    await expect(telegramHitlApprovalRepository.hasPendingForSession(current.sessionId, "wrun_hitl")).resolves.toBe(true);
    await expect(sessionRepository.recordTurnCompleted(current.sessionId, "wrun_hitl", true, true)).resolves.toBe("recorded");
    await expect(
      telegramHitlApprovalRepository.claimCallback({
        baseContinuationToken: "-1001:55:88",
        callbackData: "eve:0",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toMatchObject({ status: "authorized" });
    await expect(telegramHitlApprovalRepository.hasPendingForSession(current.sessionId, "wrun_hitl")).resolves.toBe(false);
  });

  it("keeps other simultaneously rendered requests pending", async () => {
    const current = await fixture();
    await sessionRepository.registerRouteAlias(current.sessionId, "-1001:55:89");
    await telegramHitlApprovalRepository.register({
      applicationSessionId: current.sessionId,
      kind: "tool-approval" as const,
      callbackData: ["eve:2", "eve:3"],
      callbackOptions: [
        {
          callbackData: "eve:2",
          label: "Да, подтвердить",
          optionId: "approve",
        },
        { callbackData: "eve:3", label: "Нет, отклонить", optionId: "deny" },
      ],
      eveSessionId: "wrun_hitl",
      requestId: "approval-request-2",
      promptText: "Подтвердите второе действие",
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
      telegramMessageId: "89",
      telegramMessageThreadId: "55",
      telegramUserId: OWNER_TELEGRAM_ID,
      toolCallId: "call-2",
      toolInputHash: "b".repeat(64),
      toolName: "test_tool",
    });

    await expect(
      telegramHitlApprovalRepository.claimCallback({
        baseContinuationToken: "-1001:55:88",
        callbackData: "eve:0",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toMatchObject({ status: "authorized" });
    await expect(
      telegramHitlApprovalRepository.claimCallback({
        baseContinuationToken: "-1001:55:89",
        callbackData: "eve:2",
        telegramChatId: "-1001",
        telegramMessageId: "89",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toMatchObject({ status: "authorized" });
  });

  it("clears only approvals owned by the completed Eve root", async () => {
    const current = await fixture();
    await telegramHitlApprovalRepository.register({
      applicationSessionId: current.sessionId,
      kind: "tool-approval" as const,
      callbackData: ["eve:2"],
      callbackOptions: [
        {
          callbackData: "eve:2",
          label: "Да, подтвердить",
          optionId: "approve",
        },
      ],
      eveSessionId: "wrun_hitl_new",
      requestId: "approval-request-new-root",
      promptText: "Подтвердите действие нового запуска",
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
      telegramMessageId: "90",
      telegramMessageThreadId: "55",
      telegramUserId: OWNER_TELEGRAM_ID,
      toolCallId: "call-new-root",
      toolInputHash: "c".repeat(64),
      toolName: "test_tool",
    });

    await telegramHitlApprovalRepository.clearForEveSession(current.sessionId, "wrun_hitl");

    await expect(database().query<{ eve_session_id: string }>("SELECT eve_session_id FROM telegram_hitl_approvals WHERE application_session_id = $1", [current.sessionId])).resolves.toMatchObject({
      rows: [{ eve_session_id: "wrun_hitl_new" }],
    });
  });

  it("rechecks active family membership before resuming Eve", async () => {
    const current = await fixture();
    await database().query("DELETE FROM family_memberships WHERE user_id = $1", [current.ownerId]);

    await expect(
      telegramHitlApprovalRepository.claimCallback({
        baseContinuationToken: "-1001:55:88",
        callbackData: "eve:0",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toEqual({ status: "forbidden" });
  });

  it("allows the current owner to resume an owner-only external approval", async () => {
    await fixture({
      messageMode: "owner_only",
      scope: "group",
      type: "external",
    });

    await expect(
      telegramHitlApprovalRepository.claimCallback({
        baseContinuationToken: "-1001:55:88",
        callbackData: "eve:0",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toMatchObject({ status: "authorized" });
  });

  it("rejects an owner-only external approval after owner-role revocation", async () => {
    const current = await fixture({
      messageMode: "owner_only",
      scope: "group",
      type: "external",
    });
    await database().query("UPDATE family_memberships SET role = 'member' WHERE user_id = $1", [current.ownerId]);

    await expect(
      telegramHitlApprovalRepository.claimCallback({
        baseContinuationToken: "-1001:55:88",
        callbackData: "eve:0",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toEqual({ status: "forbidden" });
  });

  it("protects and atomically consumes a text reply from the expected identity", async () => {
    await fixture({ freeform: true });

    await expect(
      telegramHitlApprovalRepository.authorizeReply({
        baseContinuationToken: "-1001:55:88",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: "202",
      }),
    ).resolves.toBe("forbidden");
    await expect(
      telegramHitlApprovalRepository.authorizeReply({
        baseContinuationToken: "-1001:55:88",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toBe("authorized");
    await expect(sessionRepository.hasRoute("-1001:55:88")).resolves.toBe(false);
    await expect(
      telegramHitlApprovalRepository.authorizeReply({
        baseContinuationToken: "-1001:55:88",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: "202",
      }),
    ).resolves.toBe("not_applicable");
    await expect(
      telegramHitlApprovalRepository.authorizeReply({
        baseContinuationToken: "-1001:55:999",
        telegramChatId: "-1001",
        telegramMessageId: "999",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toBe("not_applicable");
  });

  it("does not consume an approval button when its message receives an ordinary text reply", async () => {
    await fixture();
    expect(await telegramHitlApprovalRepository.authorizeReply({ baseContinuationToken: "-1001:55:88",telegramChatId: "-1001",
      telegramMessageId: "88",telegramUserId: OWNER_TELEGRAM_ID })).toBe("not_applicable");
    expect((await telegramHitlApprovalRepository.claimCallback({ baseContinuationToken: "-1001:55:88",telegramChatId: "-1001",
      telegramMessageId: "88",telegramUserId: OWNER_TELEGRAM_ID,callbackData: "eve:0" })).status).toBe("authorized");
  });

  it("treats a removed ordinary alias as canonical ancestry while a task awaits approval", async () => {
    await fixture();

    await expect(
      telegramHitlApprovalRepository.authorizeReply({
        baseContinuationToken: "-1001:55:77",
        telegramChatId: "-1001",
        telegramMessageId: "77",
        telegramUserId: "202",
      }),
    ).resolves.toBe("not_applicable");
  });

  it("fails closed when the route is pending but approval registration is missing", async () => {
    await fixture();
    await database().query("DELETE FROM telegram_hitl_approvals");

    await expect(
      telegramHitlApprovalRepository.authorizeReply({
        baseContinuationToken: "-1001:55:88",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: "202",
      }),
    ).resolves.toBe("expired");
  });
});
