/**
 * Headers the proxy never forwards in either direction.
 *
 * Export:
 * - `filteredHeaders`: the headers without hop-by-hop fields and proxy credentials.
 */
import type { IncomingHttpHeaders } from "node:http";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function filteredHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())),
  );
}
