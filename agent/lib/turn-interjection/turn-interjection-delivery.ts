/**
 * Records that the messages shown to a running turn reached a model call.
 *
 * Export:
 * - `recordTurnInterjectionDelivery`: marks every returned claim of the turn as delivered when the
 *   turn's next model step starts.
 *
 * Key constructs:
 * - A step starts only after every tool of the previous step has finished, so its prompt carries
 *   each result returned before it. The model's own action events are no proof: with parallel calls
 *   a fast tool can return while the model is still requesting the next one.
 * - A step that then fails still leaves the result in history; the ordinary turn's notice tells the
 *   model to act on the message if it did not manage to.
 * - A failed record never fails the person's turn: the message then reaches its ordinary turn as a
 *   new one, which can at most repeat a reply, never drop it.
 */
import type { SessionAuth } from "eve/context";

import { turnInterjectionRepository } from "./turn-interjection-repository.js";
import { resolveTurnInterjectionScope } from "./turn-interjection-scope.js";

export async function recordTurnInterjectionDelivery(
  ctx: { session: { auth: SessionAuth; id: string; parent?: unknown; turn: { id: string } } },
  repository: Pick<typeof turnInterjectionRepository, "markDelivered"> = turnInterjectionRepository,
): Promise<void> {
  if (resolveTurnInterjectionScope(ctx) === null) return;
  try {
    await repository.markDelivered(ctx.session.id, ctx.session.turn.id);
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_TURN_INTERJECTION_DELIVERY_RECORD_FAILED",
      error: error instanceof Error ? error.message : String(error),
      eveSessionId: ctx.session.id,
      eveTurnId: ctx.session.turn.id,
    }));
  }
}
