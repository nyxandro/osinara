/**
 * Durable session caller resolution.
 *
 * Export:
 * - `resolveSessionCaller`: returns only the active verified caller for this turn.
 */
import type { SessionAuth, SessionAuthContext } from "../runtime/context.js";

interface SessionAuthSource {
  session: {
    auth: SessionAuth;
  };
}

export function resolveSessionCaller(ctx: SessionAuthSource): SessionAuthContext | null {
  return ctx.session.auth.current;
}
