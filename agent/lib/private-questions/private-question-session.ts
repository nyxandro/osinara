/**
 * Whether a turn is a private question's (#467).
 *
 * Export:
 * - `isPrivateQuestionSession`: true for the turns the `private-question` channel started; tools, sandbox
 *   and instructions take their narrow private shape from it.
 *
 * The flag comes only from the auth the application built for the turn from a verified ephemeral command.
 */
import type { SessionAuth } from "../../runtime/context.js";

export function isPrivateQuestionSession(ctx: { readonly session: { readonly auth: SessionAuth } }): boolean {
  return ctx.session.auth.current?.attributes.privateQuestion === "true";
}
