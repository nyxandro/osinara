/**
 * List tool for scheduled agent scenarios.
 *
 * Export:
 * - `list_agent_schedules` returns current-user personal and family schedules.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import {
  AGENT_SCHEDULE_LIST_DEFAULT_LIMIT,
  AGENT_SCHEDULE_LIST_MAX_LIMIT,
} from "../agent-schedules/agent-schedule-config.js";
import { requireAgentScheduleAuthorization } from "../agent-schedules/agent-schedule-context.js";
import { agentScheduleRepository } from "../agent-schedules/agent-schedule-repository.js";

export default defineTool({
  // Repeating it after a crash is safe: it only reads.
  replaySafe: true,
  description: [
    "List the current user's personal and family agent schedules page by page.",
    "Result: {items,nextCursor}; if nextCursor is not null, pass it unchanged for the next page.",
    "Use it to check the last run before explaining a failure. lastRun.executionStatus is the execution state, deliveredAt the fact of delivery; completed without deliveredAt means the scenario deliberately stayed silent; taskOutcome=not_verified does not confirm that the requirements were met. diagnostics holds only observed errors, which by themselves do not prove the whole task failed. Take times for the user from nextRunAtLocal and lastRun.scheduledForLocal.",
  ].join(" "),
  inputSchema: z.object({
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(AGENT_SCHEDULE_LIST_MAX_LIMIT)
      .default(AGENT_SCHEDULE_LIST_DEFAULT_LIMIT),
  }).strict(),
  async execute(input, ctx) {
    return await agentScheduleRepository.list(requireAgentScheduleAuthorization(ctx), input);
  },
});
