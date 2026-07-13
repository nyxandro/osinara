/**
 * Sandbox runner engine boundary.
 *
 * Export:
 * - `SandboxEngine`: operations the authenticated internal HTTP server may delegate to Docker.
 */
import type {
  SandboxRunnerCreateRequest,
  SandboxRunnerProcessRequest,
  SandboxRunnerProcessResponse,
  SandboxRunnerRemovePathRequest,
  SandboxRunnerSessionResponse,
} from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";

export interface SandboxEngine {
  createSession(request: SandboxRunnerCreateRequest): Promise<SandboxRunnerSessionResponse>;
  deleteToolEnvironment(workspaceId: string): Promise<void>;
  health(): Promise<void>;
  readFile(sessionId: string, path: string): Promise<Uint8Array | null>;
  removePath(sessionId: string, request: SandboxRunnerRemovePathRequest): Promise<void>;
  runProcess(
    sessionId: string,
    request: SandboxRunnerProcessRequest,
    signal?: AbortSignal,
  ): Promise<SandboxRunnerProcessResponse>;
  removeIdleSessions(now: Date): Promise<number>;
  stopAllSessions(): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  writeFile(sessionId: string, path: string, content: Uint8Array): Promise<void>;
}
