/**
 * Session context the runtime hands to tools, instruction resolvers and channel handlers.
 *
 * Exports:
 * - `SessionAuthContext`: one verified principal with the application's string attributes.
 * - `SessionAuth`: who acts now (`current`) and who started the turn (`initiator`).
 * - `SessionTurn`, `SessionParent`: the turn identity and, for a subagent turn, its caller.
 * - `SessionContext`: session identity plus sandbox access.
 * - `DynamicResolveContext`: what an instructions, tools or skills resolver sees before a step.
 *
 * Derived from eve 0.40.0 `channel/types.ts`, `context/keys.ts`,
 * `public/definitions/callback-context.ts` and `shared/dynamic-tool-definition.ts`
 * (Apache-2.0, see NOTICE-eve). Changes: the same names and shapes, so application code keeps its
 * contract; members the application never uses (skill handles, token accessors) are left out.
 */
import type { ModelMessage } from "ai";

import type { RuntimeSandboxSession } from "./sandbox/types.js";

export interface SessionAuthContext {
  readonly attributes: Readonly<Record<string, string | readonly string[]>>;
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly subject?: string;
}

export interface SessionAuth {
  readonly current: SessionAuthContext | null;
  readonly initiator: SessionAuthContext | null;
}

export interface SessionTurn {
  readonly id: string;
  readonly sequence: number;
}

export interface SessionParent {
  readonly callId: string;
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly turn: SessionTurn;
}

export interface SessionContext {
  readonly session: {
    readonly id: string;
    readonly auth: SessionAuth;
    readonly turn: SessionTurn;
    readonly parent?: SessionParent;
  };
  getSandbox(): Promise<RuntimeSandboxSession>;
}

export interface DynamicResolveContext {
  readonly session: {
    readonly id: string;
    readonly auth: SessionAuth;
  };
  /** Channel that produced the request; `kind` is `"subagent"` for a delegated child turn. */
  readonly channel: {
    readonly kind?: string;
    readonly continuationToken?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
  /** History visible at this resolve point, oldest first, including the current message. */
  readonly messages: readonly ModelMessage[];
}
