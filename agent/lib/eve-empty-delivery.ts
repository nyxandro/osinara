/**
 * Eve's marker for a completed turn that deliberately delivers nothing.
 *
 * Export:
 * - `EVE_EMPTY_DELIVERY_MARKER`: the exact string the model writes to stay silent.
 *
 * Key construct:
 * - Eve 0.40.0 honours the marker in every turn: `harness/emission.js` emits `message.completed`
 *   with `message: null`, and `harness/tool-loop.js` drops the step from history instead of
 *   treating it as an empty response that must be reissued. Eve documents the marker only to
 *   scheduled and task turns, so the group prompt teaches it as the model's way to stay silent.
 * - The marker is not part of Eve's public API. `scripts/apply-eve-patches.ts` pins the runtime
 *   contract at install time with its own copy of this literal (Docker installs dependencies
 *   before `agent/` exists), and `eve-empty-delivery-marker.test.ts` keeps the two copies equal.
 */
export const EVE_EMPTY_DELIVERY_MARKER = "<eve-empty-delivery/>";
