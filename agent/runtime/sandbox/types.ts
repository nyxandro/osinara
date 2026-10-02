/**
 * Sandbox session the runtime gives to tools: commands and files inside the isolated runner.
 *
 * Exports:
 * - `SandboxSession` / `RuntimeSandboxSession`: AI SDK sandbox operations plus path resolution,
 *   removal and the fixed network policy of the session.
 * - `SandboxSpawnOptions`: options of one spawned command.
 *
 * Derived from eve 0.40.0 `shared/sandbox-session.ts` (Apache-2.0, see NOTICE-eve).
 * Changes: the network policy is the two values the Osinara runner supports, not Vercel's
 * rule-based policy.
 */
import type { Experimental_SandboxSession as AiSdkSandbox } from "ai";

export type SandboxSpawnOptions = Parameters<AiSdkSandbox["spawn"]>[0];

/** A trusted session has open egress through the proxy; every other session has none. */
export type SandboxNetworkPolicy = "allow-all" | "deny-all";

export interface SandboxRemovePathOptions {
  readonly abortSignal?: AbortSignal;
  readonly force?: boolean;
  readonly path: string;
  readonly recursive?: boolean;
}

export interface SandboxSession extends Pick<
  AiSdkSandbox,
  "run" | "spawn" | "readFile" | "readBinaryFile" | "readTextFile" | "writeFile" | "writeBinaryFile" | "writeTextFile"
> {
  readonly id: string;
  resolvePath(path: string): string;
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
  removePath(options: SandboxRemovePathOptions): Promise<void>;
}

export interface RuntimeSandboxSession extends SandboxSession {
  stop(): Promise<void>;
}
