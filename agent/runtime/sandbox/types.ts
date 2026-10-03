/**
 * Sandbox session the runtime gives to tools: commands and files inside the isolated runner.
 *
 * Exports:
 * - `SandboxSession` / `RuntimeSandboxSession`: AI SDK sandbox operations plus path resolution,
 *   removal, the fixed network policy of the session and the skill package sync.
 * - `SandboxSkillPackage`: one skill's files, relative to its directory under the skill root.
 * - `SandboxSpawnOptions`: options of one spawned command.
 *
 * The network policy is one of the two values the runner supports.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
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

export interface SandboxSkillPackage {
  readonly files: ReadonlyArray<{ readonly content: Uint8Array; readonly relativePath: string }>;
  readonly name: string;
}

export interface RuntimeSandboxSession extends SandboxSession {
  stop(): Promise<void>;
  /** Puts the turn's skill packages under the skill root in one batch and removes revoked ones. */
  syncSkills(packages: readonly SandboxSkillPackage[], removed: readonly string[]): Promise<void>;
}
