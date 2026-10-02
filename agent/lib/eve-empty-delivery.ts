/**
 * The marker for a completed turn that deliberately delivers nothing.
 *
 * Export:
 * - `EVE_EMPTY_DELIVERY_MARKER`: the exact string the model writes to stay silent.
 *
 * Key construct:
 * - The runtime honours the marker in every turn (`runtime/turn/step-history.ts`): the channel
 *   receives `message: null`, the step stays out of history and no empty-answer reissue fires.
 *   The group prompt teaches it as the model's way to stay silent. The name and the literal are
 *   Eve 0.40's, which transferred histories and prompts already carry.
 */
export { EMPTY_DELIVERY_MARKER as EVE_EMPTY_DELIVERY_MARKER } from "../runtime/turn/step-history.js";
