/**
 * Completion of a scheduled run that the model deliberately finished without a message.
 *
 * Export:
 * - `completeSilentAgentScheduleRun`: closes the run as successful and keeps the recurrence.
 *
 * A scenario may say to skip an empty report. Such a run is done, not a delivery that went
 * missing: it raises no failure notice, plans the next occurrence and leaves the result counter
 * untouched. The shared completion step still treats silence as unconfirmed delivery whenever a
 * message may already have reached Telegram in the same run.
 */
import { database } from "../database.js";
import { finishActiveAgentScheduleRun } from "./agent-schedule-run-completion.js";

export async function completeSilentAgentScheduleRun(
  applicationSessionId: string,
  eveSessionId: string,
  completedAt: Date,
): Promise<boolean> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const completed = await finishActiveAgentScheduleRun(client, {
      applicationSessionId,
      completedAt,
      eveSessionId,
      outcome: { kind: "silent" },
    });
    await client.query("COMMIT");
    return completed;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
