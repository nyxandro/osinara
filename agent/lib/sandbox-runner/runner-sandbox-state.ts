/**
 * Persisted sandbox backend state validation (the format Eve stored, carried over).
 *
 * Exports:
 * - `StoredSandboxMetadata`: mounted legacy/current state or disabled internal-session state.
 * - `parseStoredSandboxMetadata`: validates reconnect metadata before backend reuse.
 */
import type {
  SandboxAccess,
  WorkspaceSandboxMount,
} from "./sandbox-runner-contract.js";
import {
  parseCreateSandboxRequest,
  parseWorkspaceSandboxUseOptions,
  sandboxSeedDigest,
} from "./sandbox-runner-contract.js";

interface StoredMountedSandboxMetadata {
  access: SandboxAccess;
  disabled: false;
  mounts: WorkspaceSandboxMount[];
  sandboxSessionId: string;
  version: number;
}

interface StoredDisabledSandboxMetadata {
  disabled: true;
  mounts: [];
  sandboxSessionId: string;
  version: number;
}

export type StoredSandboxMetadata =
  | StoredDisabledSandboxMetadata
  | StoredMountedSandboxMetadata;

export function parseStoredSandboxMetadata(
  value: Record<string, unknown> | undefined,
  eveSessionId: string,
  stateSchemaVersion: number,
): StoredSandboxMetadata | null {
  if (!value) return null;
  if (value.version !== stateSchemaVersion) {
    throw new Error("AGENT_SANDBOX_RUNNER_STATE_INVALID: Reconnect schema mismatch");
  }

  // Both variants retain the same stable compute identity; disabled state has no workspace mounts.
  const useOptions = parseWorkspaceSandboxUseOptions({
    mounts: value.mounts,
    sandboxSessionId: value.sandboxSessionId,
  });
  if (value.disabled === true) {
    if (useOptions.mounts.length !== 0 || value.access !== undefined) {
      throw new Error("AGENT_SANDBOX_RUNNER_STATE_INVALID: Disabled sandbox metadata is malformed");
    }
    return {
      disabled: true,
      mounts: [],
      sandboxSessionId: useOptions.sandboxSessionId,
      version: stateSchemaVersion,
    };
  }
  if (value.disabled !== undefined && value.disabled !== false) {
    throw new Error("AGENT_SANDBOX_RUNNER_STATE_INVALID: Sandbox state discriminator is malformed");
  }

  // Existing mounted state remains compatible and reuses the runner's strict trust-zone parser.
  const request = parseCreateSandboxRequest({
    access: value.access,
    eveSessionId,
    mounts: useOptions.mounts,
    sandboxSessionId: useOptions.sandboxSessionId,
    seedDigest: sandboxSeedDigest([]),
  });
  return {
    access: request.access,
    disabled: false,
    mounts: request.mounts,
    sandboxSessionId: request.sandboxSessionId,
    version: stateSchemaVersion,
  };
}
