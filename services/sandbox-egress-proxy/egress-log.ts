/**
 * Structured log records of the sandbox egress proxy.
 *
 * Exports:
 * - `SANDBOX_EGRESS_ROUTINE_CODES`: connections that ended the way web traffic normally ends.
 * - `writeEgressLog`: writes one event as one JSON line.
 *
 * The log collector stores every output line as a separate record and counts a line without a
 * `code` field that mentions an error as a runtime failure. An object dumped by `console.error`
 * spans several lines, so one closed connection used to count as up to ten failures. Routine codes
 * are declared once here so that the error-burst alert excludes them by the names written below.
 */
// A browser cancels requests it no longer needs by closing the socket, which surfaces as EPIPE or
// ECONNRESET on the proxy side of the tunnel.
export const SANDBOX_EGRESS_CLIENT_CLOSED_CODE = "AGENT_SANDBOX_EGRESS_CLIENT_CLOSED";
// A site closing an already established tunnel is its own decision, not a failure of the egress
// path: that path is proven by the connection having been established.
export const SANDBOX_EGRESS_UPSTREAM_CLOSED_CODE = "AGENT_SANDBOX_EGRESS_UPSTREAM_CLOSED";
export const SANDBOX_EGRESS_ROUTINE_CODES = [
  SANDBOX_EGRESS_CLIENT_CLOSED_CODE,
  SANDBOX_EGRESS_UPSTREAM_CLOSED_CODE,
] as const;

const routineCodes: ReadonlySet<string> = new Set(SANDBOX_EGRESS_ROUTINE_CODES);

export type EgressLogRecord = { readonly code: string } & Readonly<Record<string, string | number | null>>;

export function writeEgressLog(record: EgressLogRecord): void {
  const line = JSON.stringify(record);
  if (routineCodes.has(record.code)) console.info(line);
  else console.error(line);
}
