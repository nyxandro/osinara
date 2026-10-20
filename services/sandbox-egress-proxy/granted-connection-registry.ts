/**
 * Open connections to owner-approved IP destinations.
 *
 * Exports:
 * - `GrantedConnection`: one open connection and how to end it.
 * - `GrantedConnectionRegistry`: tracks a connection until it closes and rechecks its grant.
 * - `createGrantedConnectionRegistry`: rechecks every tracked connection on a fixed interval.
 *
 * The gate decides when a connection opens; a tunnel or a streamed response can then stay open for
 * hours. Rechecking it on an interval makes a revocation, or a damaged grant file, end it too.
 */
import { writeEgressLog } from "./egress-log.js";
import type { NetworkAccessGate } from "./network-access-gate.js";

export interface GrantedConnection {
  readonly address: string;
  close(): void;
  readonly localAddress: string | undefined;
  readonly port: number;
}

export interface GrantedConnectionRegistry {
  recheck(): Promise<void>;
  stop(): void;
  /** Returns the function that stops tracking the connection once it has closed. */
  track(connection: GrantedConnection): () => void;
}

export function createGrantedConnectionRegistry(
  gate: NetworkAccessGate,
  intervalMilliseconds: number,
): GrantedConnectionRegistry {
  const open = new Set<GrantedConnection>();

  const recheck = async (): Promise<void> => {
    for (const connection of [...open]) {
      try {
        await gate.authorize({
          address: connection.address,
          localAddress: connection.localAddress,
          port: connection.port,
        });
      } catch (error) {
        open.delete(connection);
        writeEgressLog({
          code: "AGENT_SANDBOX_EGRESS_GRANTED_CONNECTION_CLOSED",
          errorMessage: error instanceof Error ? error.message : String(error),
          hostname: connection.address,
          port: connection.port,
        });
        connection.close();
      }
    }
  };

  let running = false;
  const timer = setInterval(() => {
    // A slow file read must not stack rechecks on top of each other.
    if (running) return;
    running = true;
    void recheck().finally(() => { running = false; });
  }, intervalMilliseconds);
  timer.unref();

  return {
    recheck,
    stop: () => clearInterval(timer),
    track(connection) {
      open.add(connection);
      return () => { open.delete(connection); };
    },
  };
}
