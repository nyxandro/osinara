/**
 * Expired approval repository integration tests.
 *
 * Constructs covered:
 * - `claimExpired`: leases only prompts older than the confirmation window, once per lease.
 * - `completeTimeout`: terminalizes the row and releases the session's rotation veto.
 * - A concurrent user decision wins the row; a failed cancellation stays retryable.
 * - Framework `session-limit` prompts are out of the confirmation window's scope.
 * - Pre-migration rows without a request kind are fail-closed.
 * - A prompt whose session no longer owns the parked Eve run is never settled.
 * - A claim carries revalidated Telegram auth, and a timed-out row is not execution evidence.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { TELEGRAM_HITL_APPROVAL_TIMEOUT_MS } from "../../config.js";
import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { telegramHitlApprovalRepository } from "./approval-repository.js";
import { approvalTimeoutRepository } from "./approval-timeout-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;
const OWNER_TELEGRAM_ID = "timeout-owner";
const NOW = new Date("2026-08-24T12:00:00.000Z");

async function fixture(
  kind: "question" | "session-limit" | "tool-approval" = "tool-approval",
): Promise<{ sessionId: string }> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Timeout') RETURNING id",
  );
  const owner = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ($1, 'Владелец') RETURNING id`,
    [OWNER_TELEGRAM_ID],
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, owner.rows[0]!.id],
  );
  const session = await sessionRepository.prepareTurn({
    baseContinuationToken: "700::",
    familyId: family.rows[0]!.id,
    groupId: null,
    kind: "canonical",
    now: NOW,
    scope: "personal",
    telegramForumTopicId: null,
    userId: owner.rows[0]!.id,
  });
  await sessionRepository.bindEveSession(session.id, "wrun_timeout");
  await sessionRepository.parkSession({
    applicationSessionId: session.id,
    pendingRequestId: "aitxt-timeout-1",
    requesterTelegramUserId: OWNER_TELEGRAM_ID,
    requesterUserId: owner.rows[0]!.id,
  });
  await sessionRepository.registerRouteAlias(session.id, "700::2801");
  await registerApproval(session.id, kind);
  return { sessionId: session.id };
}

async function registerApproval(
  sessionId: string,
  kind: "question" | "session-limit" | "tool-approval",
): Promise<void> {
  await telegramHitlApprovalRepository.register({
    applicationSessionId: sessionId,
    kind,
    callbackData: ["eve:0", "eve:1"],
    callbackOptions: [
      { callbackData: "eve:0", label: "Да, подтвердить", optionId: "approve" },
      { callbackData: "eve:1", label: "Cancel", optionId: "cancel" },
    ],
    eveSessionId: "wrun_timeout",
    promptText: "Подтвердите действие: исправить запись в памяти.",
    requestId: "aitxt-timeout-1",
    telegramChatId: "700",
    telegramChatType: "private",
    telegramMessageId: "2801",
    telegramMessageThreadId: null,
    telegramUserId: OWNER_TELEGRAM_ID,
    toolCallId: "call-timeout-1",
    toolInputHash: "b".repeat(64),
    toolName: "manage_memory",
  });
}

async function ageApproval(milliseconds: number): Promise<void> {
  await database().query(
    "UPDATE telegram_hitl_approvals SET created_at = $1::timestamptz - ($2::bigint * interval '1 millisecond')",
    [NOW, milliseconds],
  );
}

async function pendingOperation(sessionId: string): Promise<boolean> {
  const result = await database().query<{ pending_operation: boolean }>(
    "SELECT pending_operation FROM conversation_sessions WHERE id = $1",
    [sessionId],
  );
  return result.rows[0]!.pending_operation;
}

describeWithDatabase("approval timeout repository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE telegram_hitl_approvals, conversation_session_routes, conversation_sessions, family_memberships, users, families CASCADE",
    );
  });
  afterAll(async () => closeDatabase());

  it("never cancels a framework session-limit prompt", async () => {
    await fixture("session-limit");
    await ageApproval(TELEGRAM_HITL_APPROVAL_TIMEOUT_MS + 1_000);

    await expect(
      approvalTimeoutRepository.claimExpired(NOW, TELEGRAM_HITL_APPROVAL_TIMEOUT_MS),
    ).resolves.toEqual([]);
  });

  it("bounds an unanswered agent question the same way as an approval", async () => {
    await fixture("question");
    await ageApproval(TELEGRAM_HITL_APPROVAL_TIMEOUT_MS + 1_000);

    await expect(
      approvalTimeoutRepository.claimExpired(NOW, TELEGRAM_HITL_APPROVAL_TIMEOUT_MS),
    ).resolves.toHaveLength(1);
  });

  it("never cancels a pre-migration row with no request kind", async () => {
    await fixture();
    await ageApproval(TELEGRAM_HITL_APPROVAL_TIMEOUT_MS + 1_000);
    await database().query("UPDATE telegram_hitl_approvals SET request_kind = NULL");

    await expect(
      approvalTimeoutRepository.claimExpired(NOW, TELEGRAM_HITL_APPROVAL_TIMEOUT_MS),
    ).resolves.toEqual([]);
  });

  it("never settles a prompt whose session moved to another Eve run", async () => {
    await fixture();
    await ageApproval(TELEGRAM_HITL_APPROVAL_TIMEOUT_MS + 1_000);
    // A crashed run leaves the old prompt behind; settling it would clear the veto of the live one.
    await database().query("UPDATE conversation_sessions SET eve_session_id = 'wrun_newer'");

    await expect(
      approvalTimeoutRepository.claimExpired(NOW, TELEGRAM_HITL_APPROVAL_TIMEOUT_MS),
    ).resolves.toEqual([]);
  });

  it("never settles a prompt of a retired session", async () => {
    await fixture();
    await ageApproval(TELEGRAM_HITL_APPROVAL_TIMEOUT_MS + 1_000);
    await database().query("UPDATE conversation_sessions SET retired_at = now()");

    await expect(
      approvalTimeoutRepository.claimExpired(NOW, TELEGRAM_HITL_APPROVAL_TIMEOUT_MS),
    ).resolves.toEqual([]);
  });

  it("carries revalidated Telegram auth into the claim", async () => {
    const current = await fixture();
    await ageApproval(TELEGRAM_HITL_APPROVAL_TIMEOUT_MS + 1_000);

    const [claim] = await approvalTimeoutRepository.claimExpired(
      NOW,
      TELEGRAM_HITL_APPROVAL_TIMEOUT_MS,
    );

    // Eve overwrites session auth with what the response delivers, so it must be the real context.
    expect(claim!.auth.authenticator).toBe("telegram");
    const thread = (await database().query<{ thread_id: string }>(
      "SELECT thread_id FROM conversation_sessions WHERE id = $1", [current.sessionId],
    )).rows[0]!;
    expect(claim!.auth.attributes).toMatchObject({
      applicationSessionId: current.sessionId,
      memoryScopes: ["personal", "family"],
      // The continuation turn opens the session's sandbox (to sync its skills) by this id.
      sandboxSessionId: thread.thread_id,
      telegramActorId: OWNER_TELEGRAM_ID,
    });
  });

  it("does not accept a timed-out approval as tool execution evidence", async () => {
    const current = await fixture();
    await ageApproval(TELEGRAM_HITL_APPROVAL_TIMEOUT_MS + 1_000);
    const [claim] = await approvalTimeoutRepository.claimExpired(
      NOW,
      TELEGRAM_HITL_APPROVAL_TIMEOUT_MS,
    );
    await approvalTimeoutRepository.completeTimeout(claim!, NOW);

    await expect(
      telegramHitlApprovalRepository.requireToolExecutionApproval({
        applicationSessionId: current.sessionId,
        eveSessionId: "wrun_timeout",
        telegramUserId: OWNER_TELEGRAM_ID,
        toolCallId: "call-timeout-1",
        toolInputHash: "b".repeat(64),
        toolName: "manage_memory",
      }),
    ).rejects.toThrow();
  });

  it("re-opens a replayed request without violating the terminal timeout invariant", async () => {
    const current = await fixture();
    await ageApproval(TELEGRAM_HITL_APPROVAL_TIMEOUT_MS + 1_000);
    const [claim] = await approvalTimeoutRepository.claimExpired(
      NOW,
      TELEGRAM_HITL_APPROVAL_TIMEOUT_MS,
    );
    await approvalTimeoutRepository.completeTimeout(claim!, NOW);

    // Eve may replay `input.requested`; the ON CONFLICT branch must clear the timeout state.
    await expect(registerApproval(current.sessionId, "tool-approval")).resolves.toBeUndefined();
    const row = await database().query<{ consumed_at: Date | null; timed_out_at: Date | null }>(
      "SELECT consumed_at, timed_out_at FROM telegram_hitl_approvals",
    );
    expect(row.rows[0]!.consumed_at).toBeNull();
    expect(row.rows[0]!.timed_out_at).toBeNull();
  });

  it("leaves a prompt inside the confirmation window untouched", async () => {
    await fixture();
    await ageApproval(TELEGRAM_HITL_APPROVAL_TIMEOUT_MS - 1_000);

    await expect(
      approvalTimeoutRepository.claimExpired(NOW, TELEGRAM_HITL_APPROVAL_TIMEOUT_MS),
    ).resolves.toEqual([]);
  });

  it("leases an expired prompt exactly once until the lease elapses", async () => {
    await fixture();
    await ageApproval(TELEGRAM_HITL_APPROVAL_TIMEOUT_MS + 1_000);

    const claimed = await approvalTimeoutRepository.claimExpired(
      NOW,
      TELEGRAM_HITL_APPROVAL_TIMEOUT_MS,
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      eveSessionId: "wrun_timeout",
      promptText: "Подтвердите действие: исправить запись в памяти.",
      requestId: "aitxt-timeout-1",
      telegramChatId: "700",
      telegramMessageId: "2801",
      toolName: "manage_memory",
    });

    await expect(
      approvalTimeoutRepository.claimExpired(NOW, TELEGRAM_HITL_APPROVAL_TIMEOUT_MS),
    ).resolves.toEqual([]);
  });

  it("terminalizes the approval and releases the rotation veto", async () => {
    const current = await fixture();
    await ageApproval(TELEGRAM_HITL_APPROVAL_TIMEOUT_MS + 1_000);
    expect(await pendingOperation(current.sessionId)).toBe(true);

    const [claim] = await approvalTimeoutRepository.claimExpired(
      NOW,
      TELEGRAM_HITL_APPROVAL_TIMEOUT_MS,
    );

    await expect(approvalTimeoutRepository.completeTimeout(claim!, NOW)).resolves.toBe(true);
    expect(await pendingOperation(current.sessionId)).toBe(false);

    const row = await database().query<{ consumed_at: Date; timed_out_at: Date }>(
      "SELECT consumed_at, timed_out_at FROM telegram_hitl_approvals",
    );
    expect(row.rows[0]!.consumed_at).not.toBeNull();
    expect(row.rows[0]!.timed_out_at).not.toBeNull();
  });

  it("yields the row to a user decision that lands during the sweep", async () => {
    await fixture();
    await ageApproval(TELEGRAM_HITL_APPROVAL_TIMEOUT_MS + 1_000);
    const [claim] = await approvalTimeoutRepository.claimExpired(
      NOW,
      TELEGRAM_HITL_APPROVAL_TIMEOUT_MS,
    );

    await expect(
      telegramHitlApprovalRepository.claimCallback({
        baseContinuationToken: "700::2801",
        callbackData: "eve:0",
        telegramChatId: "700",
        telegramMessageId: "2801",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toMatchObject({ status: "authorized" });

    await expect(approvalTimeoutRepository.completeTimeout(claim!, NOW)).resolves.toBe(false);
  });

  it("keeps a failed cancellation retryable on the next sweep", async () => {
    await fixture();
    await ageApproval(TELEGRAM_HITL_APPROVAL_TIMEOUT_MS + 1_000);
    const [claim] = await approvalTimeoutRepository.claimExpired(
      NOW,
      TELEGRAM_HITL_APPROVAL_TIMEOUT_MS,
    );

    await approvalTimeoutRepository.failTimeout(claim!, "AGENT_APPROVAL_TIMEOUT_RESPONSE_FAILED");

    await expect(
      approvalTimeoutRepository.claimExpired(NOW, TELEGRAM_HITL_APPROVAL_TIMEOUT_MS),
    ).resolves.toHaveLength(1);
  });
});
