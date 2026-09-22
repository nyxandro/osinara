/**
 * Alert rule contract tests.
 *
 * An alert that fires when nothing is wrong costs more than no alert at all: the duty reader
 * learns to skip this project, and the one alert that matters goes unread with the rest.
 *
 * Constructs covered:
 * - Scheduler heartbeat rules hold longer than the chain that delays the metric after a release.
 * - Every rule watching the embedding family ignores the codes that report normal operation.
 * - The worker announces itself through the shared constant instead of a second literal.
 *
 * The rules are YAML installed on another host, so they are read as text here for the same reason
 * `production-deploy-window.test.ts` does: the two halves of each contract live in different files
 * and break silently.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SESSION_RETENTION_ROUTINE_CODES } from "./agent/config.js";
import { MEMORY_EMBEDDING_LIFECYCLE_CODES } from "./agent/lib/memory-config.js";

const projectRoot = new URL("./", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, projectRoot), "utf8");

/**
 * How long the heartbeat metric can legitimately stay away after a release, from the moment the
 * deployment closes its noise window. Each step is bounded by configuration:
 *
 * - up to 60s until the next whole minute, because each dispatcher is `cron: "* * * * *"`;
 * - up to 60s of aggregation, because the log rule group runs at `interval: 1m`;
 * - up to 30s of evaluation, because this alert group runs at `interval: 30s`.
 *
 * The first cycle's own duration sits on top and has no bound in configuration: the memory review
 * dispatcher drains whatever the downtime accumulated. The hold therefore has to exceed these
 * three minutes with room to spare, not merely reach them.
 */
const RESUME_CHAIN_MINUTES = 3;
// A hold is a delay on a real outage too. Past ten minutes this alert would report later than
// OsinaraIngressStuck, which waits ten, and the family would notice before the alert did.
const MAX_HOLD_MINUTES = 10;

const rules = read("infra/monitoring/rules/metrics/osinara.yaml");

function alertBlocks(name: string): string[] {
  return rules
    .split(/^ *- alert: /mu)
    .slice(1)
    .filter((block) => block.split("\n", 1)[0]!.trim() === name);
}

/**
 * The value of one key of the rule itself, read at the indentation of `expr:`, with a folded
 * scalar's continuation lines included. Text inside annotations sits deeper and never matches.
 */
function ruleField(block: string, key: string): string | null {
  const lines = block.split("\n");
  const indent = /^( +)expr:/mu.exec(block)?.[1];
  if (indent === undefined) return null;
  const start = lines.findIndex((line) => line.startsWith(`${indent}${key}:`));
  if (start === -1) return null;
  const inline = lines[start]!.slice(indent.length + key.length + 1).trim();
  if (!/^[>|]-?$/u.test(inline)) return inline;
  const continuation: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !line.startsWith(`${indent} `)) break;
    continuation.push(line.trim());
  }
  return continuation.join(" ").trim();
}

function holdMinutes(block: string): number | null {
  const hold = ruleField(block, "for")?.match(/^(\d+)(m|s)$/u);
  if (hold === null || hold === undefined) return null;
  return hold[2] === "s" ? Number(hold[1]) / 60 : Number(hold[1]);
}

/**
 * A rule may drop a code by naming it outright or by leaving it out of an alternation that has
 * the shared `AGENT_` prefix factored out. Both forms are in use, and both count.
 */
function excludesCode(block: string, code: string): boolean {
  const expression = ruleField(block, "expr") ?? "";
  if (expression.includes(`code!="${code}"`)) return true;
  const suffix = code.replace(/^AGENT_/u, "");
  return /code!~"AGENT_\(([^"]+)\)"/u.exec(expression)?.[1]?.split("|").includes(suffix) === true;
}

describe("reading a rule", () => {
  it("counts an exclusion only inside the rule's own expression", () => {
    // A runbook that quotes the matcher must not pass for the rule actually applying it.
    const block = [
      "OsinaraExample",
      "        expr: >-",
      "          sum(log_code_lines_1m{code=~\"AGENT_MEMORY_EMBEDDING_.+\"}[5m]) > 0",
      "        annotations:",
      "          runbook: 'see code!=\"AGENT_MEMORY_EMBEDDING_WORKER_STARTED\"'",
      "",
    ].join("\n");

    expect(excludesCode(block, "AGENT_MEMORY_EMBEDDING_WORKER_STARTED")).toBe(false);
  });

  it("reads the hold of the rule, not a duration mentioned in its text", () => {
    const block = [
      "OsinaraExample",
      "        expr: up == 0",
      "        annotations:",
      "          description: 'for: 30m is what an older version used'",
      "",
    ].join("\n");

    expect(holdMinutes(block)).toBeNull();
  });
});

describe("osinara alert rules", () => {
  it("holds the scheduler heartbeat alerts longer than a release takes to report", () => {
    const blocks = alertBlocks("OsinaraSchedulerHeartbeatMissing");

    // One per dispatcher; all three fire together, because all three wait on the same restart.
    expect(blocks.length, "one rule per dispatcher").toBe(3);
    for (const block of blocks) {
      const hold = holdMinutes(block);
      expect(hold, `rule fires on a single evaluation:\n${block}`).not.toBeNull();
      expect(hold!, "hold must outlast the resume chain").toBeGreaterThan(RESUME_CHAIN_MINUTES);
      expect(hold!, "hold delays a real outage too").toBeLessThanOrEqual(MAX_HOLD_MINUTES);
    }
  });

  it.each(["OsinaraEmbeddingFailed", "OsinaraErrorBurst"])(
    "keeps %s off every code that reports normal operation",
    (alert) => {
      const [block] = alertBlocks(alert);

      expect(block, `the alert this guards has been renamed`).toBeDefined();
      expect(MEMORY_EMBEDDING_LIFECYCLE_CODES.length).toBeGreaterThan(0);
      for (const code of MEMORY_EMBEDDING_LIFECYCLE_CODES) {
        // Both rules match their family broadly, which is right for the codes that are failures
        // and wrong for the one that says the indexer is alive.
        expect(excludesCode(block!, code), `${alert} still counts ${code}`).toBe(true);
      }
    },
  );

  it("keeps OsinaraErrorBurst off the codes a healthy session cleanup writes", () => {
    const [block] = alertBlocks("OsinaraErrorBurst");

    // The first sweep after release deletes the whole backlog of abandoned runs and writes one
    // line per run: on production that is 290 lines, twenty-nine times this alert's threshold.
    expect(SESSION_RETENTION_ROUTINE_CODES.length).toBeGreaterThan(0);
    for (const code of SESSION_RETENTION_ROUTINE_CODES) {
      expect(excludesCode(block!, code), `OsinaraErrorBurst still counts ${code}`).toBe(true);
    }
  });

  it("announces the worker through the shared constant, not a second literal", () => {
    const worker = read("scripts/memory-embedding-worker.ts")
      + read("scripts/memory-embedding/worker-loop.ts");

    // Two copies of the same code drift apart silently: the rule would keep excluding the old
    // spelling while the worker wrote the new one, and the alert would fire on a healthy start.
    expect(worker).toContain("code: MEMORY_EMBEDDING_WORKER_STARTED_CODE");
    for (const code of MEMORY_EMBEDDING_LIFECYCLE_CODES) {
      expect(worker, `${code} is spelled out a second time here`).not.toContain(`"${code}"`);
    }
  });
});
