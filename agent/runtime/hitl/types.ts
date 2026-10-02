/**
 * Shapes of a person's answer to a pending question or approval.
 *
 * Export:
 * - `InputResponse`: the selected option or freeform text for one pending request.
 *
 * Derived from eve 0.40.0 `runtime/input/types.ts` (Apache-2.0, see NOTICE-eve).
 * Changes: a plain type instead of a zod schema; the runtime validates answers where they enter.
 */
export interface InputResponse {
  readonly optionId?: string;
  readonly requestId: string;
  readonly text?: string;
}
