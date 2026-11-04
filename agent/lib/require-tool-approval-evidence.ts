/**
 * Durable tool-execution approval guard for Telegram HITL.
 *
 * Exports:
 * - `requireToolApprovalEvidence`: binds execution to the exact approved tool call.
 * - `withConfirmedCall`: the context of a tool that runs inside another tool's confirmed call.
 *
 * The owner's settings door (#459) runs a section's tool under its own call: the person confirmed the
 * door's call, recorded under the door's name and the input the model sent it, so that is the call
 * the section's tool must find confirmed, not its own name and input.
 */
import type { ToolContext } from "../runtime/tool.js";

import { AppError } from "./app-error.js";
import { memoryOperationHash } from "./memory-record.js";
import { applicationSessionId } from "./sessions/session-context.js";
import { telegramHitlApprovalRepository } from "./telegram-hitl/approval-repository.js";

export interface ConfirmedCall {
  readonly input: unknown;
  readonly toolName: string;
}

type ContextWithConfirmedCall = ToolContext & { readonly confirmedCall?: ConfirmedCall };

export function withConfirmedCall(ctx: ToolContext, call: ConfirmedCall): ToolContext {
  return { ...ctx, confirmedCall: call } as ContextWithConfirmedCall;
}

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
  const confirmed = (ctx as ContextWithConfirmedCall).confirmedCall ?? { input: toolInput, toolName };
  await telegramHitlApprovalRepository.requireToolExecutionApproval({
    applicationSessionId: applicationSessionId(ctx),
    agentSessionId: ctx.session.id,
    telegramUserId,
    toolCallId: ctx.callId,
    toolInputHash: memoryOperationHash(confirmed.input),
    toolName: confirmed.toolName,
  });
}
