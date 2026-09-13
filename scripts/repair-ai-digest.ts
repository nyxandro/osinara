/** Explicit, preview-first operator entrypoint; execute inside the released backend container. */
import { parseArgs } from "node:util";
import { closeDatabase, database } from "../agent/lib/database.js";
import { repairAiDigestSchedule } from "../agent/lib/agent-schedules/ai-digest-repair.js";

try {
  const { values } = parseArgs({ options: {
    "schedule-id": { type: "string" }, "expected-scenario-sha256": { type: "string" },
    "expected-sources-sha256": { type: "string" },
    "expected-new-scenario-sha256": { type: "string" },
    mailbox: { type: "string" }, "source-memory-ref": { type: "string", multiple: true },
    apply: { type: "boolean", default: false },
  }, strict: true });
  const result = await repairAiDigestSchedule({
    scheduleId: values["schedule-id"]!, expectedScenarioSha256: values["expected-scenario-sha256"]!,
    expectedSourcesSha256: values["expected-sources-sha256"],
    expectedNewScenarioSha256: values["expected-new-scenario-sha256"],
    mailbox: values.mailbox!, sourceMemoryRefs: values["source-memory-ref"]!, apply: values.apply!,
  }, { pool: database(), workspaceRoot: "/app/workspaces" });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ code: "AGENT_DIGEST_REPAIR_FAILED",
    message: error instanceof Error ? error.message : "Не удалось исправить сценарий дайджеста" }));
  process.exitCode = 1;
} finally { await closeDatabase(); }
