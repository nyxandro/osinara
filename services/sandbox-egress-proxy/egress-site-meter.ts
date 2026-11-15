/**
 * Minute tally of the sites the egress proxy opened and could not reach (#499).
 *
 * Exports:
 * - `EgressSiteMeter`: what the proxy reports as each site's connection is decided.
 * - `createEgressSiteMeter`: the tally that writes one `AGENT_SANDBOX_EGRESS_SITE_METRICS` line per interval.
 *
 * Every site the bot reaches goes through this proxy: `web_fetch`, the sandbox browser and commands.
 * One site that does not open is not an alert; a whole day of attempts with nothing opened is
 * (OsinaraSitesUnreachable). The line is written even for a quiet interval: the alert waits until the
 * hub holds a full day of these lines, and silence must not read as a missing day. Counts since the
 * last line are lost when the process stops, at most one interval.
 */
import { SANDBOX_EGRESS_SITE_METRICS_CODE, writeEgressLog } from "./egress-log.js";

export interface EgressSiteMeter {
  /** The site answered: a tunnel was established or its response began. */
  opened(): void;
  /** The site could not be reached: no connection, no answer, or no answer from DNS for its name. */
  failed(): void;
}

export interface EgressSiteMeterReporter extends EgressSiteMeter {
  /** Writes the tally on a fixed interval; returns the function that stops it. */
  start(intervalMilliseconds: number): () => void;
}

export function createEgressSiteMeter(): EgressSiteMeterReporter {
  let opened = 0;
  let failed = 0;
  const report = () => {
    writeEgressLog({ code: SANDBOX_EGRESS_SITE_METRICS_CODE, failed, opened });
    opened = 0;
    failed = 0;
  };
  return {
    failed() {
      failed += 1;
    },
    opened() {
      opened += 1;
    },
    start(intervalMilliseconds) {
      const timer = setInterval(report, intervalMilliseconds);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
