/**
 * Delivery record for messages shown to a running turn.
 *
 * Export:
 * - Eve stream hook: a starting model step carries every tool result returned before it.
 */
import { defineHook } from "eve/hooks";

import { recordTurnInterjectionDelivery } from "../lib/turn-interjection/turn-interjection-delivery.js";

export default defineHook({
  events: {
    "step.started": async (_event, ctx) => await recordTurnInterjectionDelivery(ctx),
  },
});
