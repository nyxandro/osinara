/**
 * Proof of life for the application's periodic dispatchers.
 *
 * Exports:
 * - `SCHEDULE_HEARTBEAT_CODE`: stable code external monitoring matches on.
 * - `withScheduleHeartbeat`: runs one dispatcher cycle and records it only when it completed.
 *
 * A stopped scheduler produces no error: reminders simply never arrive. The only observable
 * difference between a healthy minute and a dead one is this line, so it is written after the
 * cycle succeeds and never written when it fails.
 */
import { AppError } from "./app-error.js";

export const SCHEDULE_HEARTBEAT_CODE = "AGENT_SCHEDULE_TICK";

const SCHEDULE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

export async function withScheduleHeartbeat<T>(
  schedule: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!SCHEDULE_NAME_PATTERN.test(schedule)) {
    throw new AppError(
      "AGENT_SCHEDULE_HEARTBEAT_INVALID",
      "Не удалось проверить имя периодической задачи",
    );
  }
  const result = await run();
  console.info(JSON.stringify({ code: SCHEDULE_HEARTBEAT_CODE, schedule }));
  return result;
}
