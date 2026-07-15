/**
 * Eve list tool for scheduled agent scenarios.
 *
 * Export:
 * - `list_agent_schedules` returns current-user personal and family schedules.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireAgentScheduleAuthorization } from "../lib/agent-schedules/agent-schedule-context.js";
import { agentScheduleRepository } from "../lib/agent-schedules/agent-schedule-repository.js";

export default defineTool({
  description: "Показать личные и семейные запланированные агентные сценарии текущего пользователя.",
  inputSchema: z.object({}).strict(),
  async execute(_input, ctx) {
    return await agentScheduleRepository.list(requireAgentScheduleAuthorization(ctx));
  },
});
