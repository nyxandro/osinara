/**
 * Structured log records of the sandbox egress proxy.
 *
 * Exports:
 * - `SANDBOX_EGRESS_ROUTINE_CODES`: connections that ended the way web traffic normally ends.
 * - `SANDBOX_EGRESS_HOST_NOT_FOUND_CODE`: the routine code of a name public DNS does not know.
 * - `SANDBOX_EGRESS_UPSTREAM_ENABLED_CODE`: the startup record of the upstream route (#489).
 * - `SANDBOX_EGRESS_SITE_METRICS_CODE`: the minute tally of sites opened and not reached (#499).
 * - `SANDBOX_EGRESS_SITE_FAILURE_CODES`: a site that did not open, recorded but not alerted on alone.
 * - `writeEgressLog`: writes one event as one JSON line.
 *
 * The log collector stores every output line as a separate record and counts a line without a
 * `code` field that mentions an error as a runtime failure. An object dumped by `console.error`
 * spans several lines, so one closed connection used to count as up to ten failures. Routine codes
 * are declared once here so that the error-burst alert excludes them by the names written below.
 *
 * A site that did not open stays a failure line, but the owner decided that one unreachable site is
 * not an alert: only a whole day of attempts with nothing opened is (#499, OsinaraSitesUnreachable,
 * which reads the minute tally). The burst alert excludes these codes too, and a test holds it to them.
 */
// A browser cancels requests it no longer needs by closing the socket, which surfaces as EPIPE or
// ECONNRESET on the proxy side of the tunnel.
export const SANDBOX_EGRESS_CLIENT_CLOSED_CODE = "AGENT_SANDBOX_EGRESS_CLIENT_CLOSED";
// A site closing an already established tunnel is its own decision, not a failure of the egress
// path: that path is proven by the connection having been established.
export const SANDBOX_EGRESS_UPSTREAM_CLOSED_CODE = "AGENT_SANDBOX_EGRESS_UPSTREAM_CLOSED";
// A name public DNS has no IPv4 address for is a mistyped or retired address: the resolver answered,
// so the egress path works. A resolver that did not answer stays a failure.
export const SANDBOX_EGRESS_HOST_NOT_FOUND_CODE = "AGENT_SANDBOX_EGRESS_HOST_NOT_FOUND";
// Once at startup when Russian sites go through the upstream proxy (#489): a setting, not a failure.
export const SANDBOX_EGRESS_UPSTREAM_ENABLED_CODE = "AGENT_SANDBOX_EGRESS_UPSTREAM_ENABLED";
// Once a minute, quiet minutes included: how many sites opened and how many could not be reached.
export const SANDBOX_EGRESS_SITE_METRICS_CODE = "AGENT_SANDBOX_EGRESS_SITE_METRICS";
export const SANDBOX_EGRESS_ROUTINE_CODES = [
  SANDBOX_EGRESS_CLIENT_CLOSED_CODE,
  SANDBOX_EGRESS_UPSTREAM_CLOSED_CODE,
  SANDBOX_EGRESS_HOST_NOT_FOUND_CODE,
  SANDBOX_EGRESS_UPSTREAM_ENABLED_CODE,
  SANDBOX_EGRESS_SITE_METRICS_CODE,
] as const;

// No connection to the site, or a tunnel through the upstream proxy that never brought its answer.
export const SANDBOX_EGRESS_UPSTREAM_FAILED_CODE = "AGENT_SANDBOX_EGRESS_UPSTREAM_FAILED";
// A plain HTTP site that gave no response.
export const SANDBOX_EGRESS_HTTP_FAILED_CODE = "AGENT_SANDBOX_EGRESS_HTTP_FAILED";
// Public DNS did not answer for the site's name; a name it answered does not exist is HOST_NOT_FOUND.
export const SANDBOX_EGRESS_IPV4_RESOLUTION_FAILED_CODE = "AGENT_SANDBOX_EGRESS_IPV4_RESOLUTION_FAILED";
export const SANDBOX_EGRESS_SITE_FAILURE_CODES = [
  SANDBOX_EGRESS_UPSTREAM_FAILED_CODE,
  SANDBOX_EGRESS_HTTP_FAILED_CODE,
  SANDBOX_EGRESS_IPV4_RESOLUTION_FAILED_CODE,
] as const;

// The host's upstream proxy (Xray) refused, could not be reached or did not open the tunnel in time:
// no site was even asked, so this is our own path broken and stays an alert (#499).
export const SANDBOX_EGRESS_UPSTREAM_PROXY_FAILED_CODE = "AGENT_SANDBOX_EGRESS_UPSTREAM_PROXY_FAILED";

const routineCodes: ReadonlySet<string> = new Set(SANDBOX_EGRESS_ROUTINE_CODES);

export type EgressLogRecord = { readonly code: string } & Readonly<Record<string, string | number | null>>;

export function writeEgressLog(record: EgressLogRecord): void {
  const line = JSON.stringify(record);
  if (routineCodes.has(record.code)) console.info(line);
  else console.error(line);
}
