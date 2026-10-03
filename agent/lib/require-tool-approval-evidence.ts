/**
 * Durable tool-execution approval guard for Telegram HITL.
 *
 * Export:
 * - `requireToolApprovalEvidence`: binds execution to the exact approved tool call.
 */
import type { ToolContext } from "../runtime/tool.js";

import { AppError } from "./app-error.js";
import { memoryOperationHash } from "./memory-record.js";
import { applicationSessionId } from "./sessions/session-context.js";
import { telegramHitlApprovalRepository } from "./telegram-hitl/approval-repository.js";

export async function requireToolApprovalEvidence(
  ctx: ToolContext,
  toolName: string,
  toolInput: unknown,
): Promise<void> {
  const telegramUserId = ctx.session.auth.current?.attributes.telegramUserId;
  if (typeof telegramUserId !== "string") {
    throw new AppError(
      "AGENT_TOOL_APPROVAL_IDENTITY_MISSING",
      "Не удалось подтвердить пользователя Telegram для выполнения действия. Запросите подтверждение заново",
    );
  }
  await telegramHitlApprovalRepository.requireToolExecutionApproval({
    applicationSessionId: applicationSessionId(ctx),
    agentSessionId: ctx.session.id,
    telegramUserId,
    toolCallId: ctx.callId,
    toolInputHash: memoryOperationHash(toolInput),
    toolName,
  });
}
