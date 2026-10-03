/**
 * Shapes of a request that waits for a person, and of the person's answer.
 *
 * Exports:
 * - `InputOption`, `InputRequest`: one pending question or tool approval as channels render it.
 * - `InputResponse`: the selected option or freeform text for one pending request.
 *
 * Derived from eve 0.40.0 `runtime/input/types.ts` (Apache-2.0, see NOTICE-eve).
 * Changes: plain types instead of zod schemas; the runtime validates answers where they enter.
 * There is no `session-limit` kind: Osinara sets no session token budget.
 */
export interface InputOption {
  readonly description?: string;
  readonly id: string;
  readonly label: string;
  readonly style?: "danger" | "default" | "primary";
}

export interface InputRequest {
  readonly action: {
    readonly callId: string;
    readonly input: Record<string, unknown>;
    readonly kind: "tool-call";
    readonly toolName: string;
  };
  readonly allowFreeform?: boolean;
  readonly display?: "confirmation" | "select" | "text";
  readonly kind: "question" | "tool-approval";
  readonly options?: readonly InputOption[];
  readonly prompt: string;
  /** Carried by the buttons; an approval's id is shown to the model in the pending-approvals note. */
  readonly requestId: string;
}

export interface InputResponse {
  readonly optionId?: string;
  readonly requestId: string;
  readonly text?: string;
}
