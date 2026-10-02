/**
 * Unanswered Telegram HITL approval timeout resolution.
 *
 * Exports:
 * - `TimedOutApprovalClaim`: one leased request that outlived the confirmation window.
 * - `createApprovalTimeoutResolver`: dependency-injected sweep over expired requests.
 * - `approvalTimeoutContext`: model-facing explanation attached to the synthetic cancellation.
 *
 * Key constructs:
 * - Eve settles an approval by option id only, so the timeout reason travels as session context.
 * - The response carries the same freshly revalidated auth the interactive callback path delivers,
 *   because Eve replaces session auth with whatever a response supplies.
 * - A dead session is settled rather than retried: its parked turn can never resume.
 */
import type { SessionAuthContext } from "../../runtime/context.js";
import type { Session } from "eve/channels";

import { TELEGRAM_HITL_APPROVAL_TIMEOUT_MS } from "../../config.js";

export interface TimedOutApprovalClaim {
  applicationSessionId: string;
  /** Revalidated Telegram auth for the resumed turn; Eve overwrites session auth with it. */
  auth: SessionAuthContext;
  eveSessionId: string;
  id: string;
  kind: "question" | "tool-approval";
  leaseToken: string;
  promptText: string;
  requestId: string;
  telegramChatId: string;
  telegramMessageId: string;
  toolName: string | null;
}

export interface ApprovalTimeoutRepository {
  claimExpired(now: Date, timeoutMilliseconds: number): Promise<TimedOutApprovalClaim[]>;
  completeTimeout(claim: TimedOutApprovalClaim, now: Date): Promise<boolean>;
  failTimeout(claim: TimedOutApprovalClaim, errorCode: string): Promise<void>;
}

export interface ApprovalTimeoutDependencies {
  attachSession(eveSessionId: string): Pick<Session, "respond">;
  finalizePrompt(claim: TimedOutApprovalClaim): Promise<void>;
  repository: ApprovalTimeoutRepository;
}

const TIMEOUT_RESPONSE_FAILED = "AGENT_APPROVAL_TIMEOUT_RESPONSE_FAILED";
const TIMEOUT_SETTLEMENT_FAILED = "AGENT_APPROVAL_TIMEOUT_SETTLEMENT_FAILED";
const TIMEOUT_LEASE_RELEASE_FAILED = "AGENT_APPROVAL_TIMEOUT_LEASE_RELEASE_FAILED";
const TIMEOUT_SESSION_INACTIVE = "AGENT_APPROVAL_TIMEOUT_SESSION_INACTIVE";
const TIMEOUT_PROMPT_FINALIZE_FAILED = "AGENT_APPROVAL_TIMEOUT_PROMPT_FINALIZE_FAILED";
const TIMEOUT_MINUTES = Math.round(TELEGRAM_HITL_APPROVAL_TIMEOUT_MS / 60_000);
const NO_ANSWER_TEXT = "Пользователь не ответил на вопрос вовремя.";

export function approvalTimeoutContext(claim: TimedOutApprovalClaim): string {
  const subject = claim.kind === "question"
    ? "не ответил на заданный вопрос"
    : claim.toolName === null
    ? "не подтвердил запрошенное действие"
    : `не подтвердил действие «${claim.toolName}»`;
  return [
    `Пользователь ${subject} более ${TIMEOUT_MINUTES} мин, поэтому оно не выполнено.`,
    "Сообщи пользователю, что подтверждение не получено и действие не отработало, и продолжай работу как обычно.",
    "Не запрашивай подтверждение этого действия повторно, пока пользователь явно не попросит его выполнить.",
  ].join(" ");
}

/** Eve resolves an approval only by option id; a question has no option the user ever saw. */
function timeoutInputResponse(claim: TimedOutApprovalClaim) {
  return claim.kind === "question"
    ? { requestId: claim.requestId, text: NO_ANSWER_TEXT }
    : { optionId: "cancel", requestId: claim.requestId };
}

export function createApprovalTimeoutResolver(dependencies: ApprovalTimeoutDependencies) {
  return async function resolveTimedOutApprovals(now: Date): Promise<number> {
    const claims = await dependencies.repository.claimExpired(
      now,
      TELEGRAM_HITL_APPROVAL_TIMEOUT_MS,
    );
    let resolved = 0;
    for (const claim of claims) {
      if (await resolveOne(dependencies, claim, now)) resolved += 1;
    }
    return resolved;
  };
}

async function resolveOne(
  dependencies: ApprovalTimeoutDependencies,
  claim: TimedOutApprovalClaim,
  now: Date,
): Promise<boolean> {
  let active: boolean;
  try {
    // Eve settles the original tool call exactly once. Cancel keeps the side effect unexecuted while
    // the persisted context carries the reason, which the hardcoded approval outcome cannot express.
    const result = await dependencies.attachSession(claim.eveSessionId).respond(
      [timeoutInputResponse(claim)],
      { auth: claim.auth, context: [approvalTimeoutContext(claim)] },
    );
    active = result.status === "accepted";
    if (!active) {
      // The parked turn is gone; settling the row is the only way to release the rotation veto.
      console.error(JSON.stringify({
        approvalId: claim.id,
        code: TIMEOUT_SESSION_INACTIVE,
        eveSessionId: claim.eveSessionId,
      }));
    }
  } catch (error) {
    // The lease is released so the next sweep retries; a frozen chat must never be the resting state.
    console.error(JSON.stringify({
      approvalId: claim.id,
      code: TIMEOUT_RESPONSE_FAILED,
      error: error instanceof Error ? error.message : String(error),
      eveSessionId: claim.eveSessionId,
    }));
    try {
      await dependencies.repository.failTimeout(claim, TIMEOUT_RESPONSE_FAILED);
    } catch (releaseError) {
      // The lease expires on its own; losing it must not abandon the rest of the leased batch.
      console.error(JSON.stringify({
        approvalId: claim.id,
        code: TIMEOUT_LEASE_RELEASE_FAILED,
        error: releaseError instanceof Error ? releaseError.message : String(releaseError),
      }));
    }
    return false;
  }

  let settled: boolean;
  try {
    // A concurrent user tap wins the row; only the sweep that terminalizes it rewrites the prompt.
    settled = await dependencies.repository.completeTimeout(claim, now);
  } catch (error) {
    // One failed settlement must not abandon the rest of the leased batch.
    console.error(JSON.stringify({
      approvalId: claim.id,
      code: TIMEOUT_SETTLEMENT_FAILED,
      error: error instanceof Error ? error.message : String(error),
    }));
    return false;
  }
  if (!settled) return false;

  try {
    await dependencies.finalizePrompt(claim);
  } catch (error) {
    // The approval is already terminal; a stale keyboard is cosmetic and must not retry the cancel.
    console.error(JSON.stringify({
      approvalId: claim.id,
      code: TIMEOUT_PROMPT_FINALIZE_FAILED,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return active;
}
