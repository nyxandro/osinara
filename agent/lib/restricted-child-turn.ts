/**
 * Turns that work without a person and must not act as the main agent of the chat.
 *
 * Export:
 * - `isRestrictedChildTurn`: true for a delegated child (`agent` tool) and for a background task's turn
 *   (#519). Both mostly read untrusted pages and nobody watches them: they keep Google for reading, see
 *   no messages of the chat, send nothing into it and change nothing outside their sandbox; the main
 *   agent reads their result first.
 */
import type { SessionAuth } from "../runtime/context.js";

import { isBackgroundTaskSession } from "./background-tasks/background-task-session.js";

export function isRestrictedChildTurn(session: { readonly auth: SessionAuth; readonly parent?: unknown }): boolean {
  return (session.parent !== undefined && session.parent !== null) || isBackgroundTaskSession({ session });
}
