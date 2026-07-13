/**
 * Durable Eve session caller resolution.
 *
 * Export:
 * - `resolveSessionCaller`: returns the active verified caller or the durable initiator for HITL resume.
 */
import type { SessionAuth, SessionAuthContext } from "eve/context";

interface SessionAuthSource {
  session: {
    auth: SessionAuth;
  };
}

export function resolveSessionCaller(ctx: SessionAuthSource): SessionAuthContext | null {
  if (ctx.session.auth.current) return ctx.session.auth.current;

  // Eve Telegram HITL callbacks resume with current=null. Reuse the verified initiator only in
  // a private chat; a group button can be clicked by someone other than the original caller.
  const initiator = ctx.session.auth.initiator;
  return initiator?.authenticator === "telegram" &&
    initiator.attributes.telegramChatType === "private"
    ? initiator
    : null;
}
