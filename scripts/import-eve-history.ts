/**
 * Deployment and operator entry point of the Eve history import.
 *
 * Usage: `import-eve-history [--dry-run]`.
 * - Without flags: imports the history of every active session in one transaction, so a failure
 *   leaves nothing imported and a repeated run continues where the previous one stopped.
 * - `--dry-run`: opens both databases read-only, reads and counts every snapshot, writes nothing.
 *   Run it against production before a release, so a format surprise is found before deployment.
 *
 * Requires `DATABASE_URL` (application) and `WORKFLOW_POSTGRES_URL` (Eve's Workflow database).
 * Every outcome is one JSON log line with a code; a failure exits non-zero.
 */
import pg from "pg";

import { importEveHistory } from "../agent/runtime/history/import-eve-history.js";

const { Client } = pg;

function requiredUrl(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`AGENT_EVE_HISTORY_IMPORT_CONFIG_MISSING: Не задано подключение ${name}`);
  return value;
}

const flags = process.argv.slice(2);
if (flags.some((flag) => flag !== "--dry-run")) {
  throw new Error(`AGENT_EVE_HISTORY_IMPORT_ARGUMENT_INVALID: Неизвестные параметры: ${flags.join(" ")}`);
}
const dryRun = flags.includes("--dry-run");
const app = new Client({ connectionString: requiredUrl("DATABASE_URL") });
const workflow = new Client({ connectionString: requiredUrl("WORKFLOW_POSTGRES_URL") });
const log = (event: Record<string, unknown>) => console.info(JSON.stringify(event));

await app.connect();
await workflow.connect();
try {
  // Eve's database is only ever read; a dry run also guarantees the application database stays untouched.
  await workflow.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  if (dryRun) await app.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  await app.query("BEGIN");
  const sessions = await importEveHistory({ app, dryRun, log, workflow }).catch(async (error: unknown) => {
    await app.query("ROLLBACK");
    throw error;
  });
  await app.query(dryRun ? "ROLLBACK" : "COMMIT");
  for (const session of sessions) log({ code: "AGENT_EVE_HISTORY_SESSION", ...session });
  log({
    code: dryRun ? "AGENT_EVE_HISTORY_DRY_RUN_COMPLETED" : "AGENT_EVE_HISTORY_IMPORT_COMPLETED",
    messages: sessions.reduce((total, session) => total + session.messages, 0),
    sessions: sessions.length,
  });
} catch (error) {
  console.error(JSON.stringify({
    code: "AGENT_EVE_HISTORY_IMPORT_FAILED",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
} finally {
  await Promise.allSettled([app.end(), workflow.end()]);
}
