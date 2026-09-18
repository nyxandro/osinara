/**
 * Where a confirmation prompt can exist at all.
 *
 * Exports:
 * - `groupApprovalDenial`: denies a tool whose confirmation could never be shown in this chat.
 *
 * Key constructs:
 * - The enforced boundary stays in the channel, which knows the verified chat type. This denial only
 *   turns a doomed turn into an ordinary tool refusal the model can explain to the chat, so it acts
 *   on a positively known group and never guesses a chat it cannot see.
 */
import type { SessionContext } from "eve/context";

const DENIAL_REASON =
  "AGENT_APPROVAL_SURFACE_UNAVAILABLE: Действие требует подтверждения, а в общем чате подтверждение запросить нельзя, поэтому здесь оно недоступно. Скажи это участнику обычной репликой, не обещай выполнить действие позже и не отправляй его в личный чат: там доступны другие данные, а не данные этой группы.";

export function groupApprovalDenial(
  ctx: Pick<SessionContext, "session">,
): { reason: string; type: "denied" } | null {
  const groupTurn = ctx.session.auth.current?.attributes.groupType !== undefined;
  return groupTurn ? { reason: DENIAL_REASON, type: "denied" } : null;
}
