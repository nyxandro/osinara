/**
 * The list action of `manage_agent_schedule` (#457: it replaced the separate list tool).
 *
 * Exports:
 * - `AGENT_SCHEDULE_LIST_FIELDS`: the paging fields the tool's schema adds for the list.
 * - `AGENT_SCHEDULE_LIST_DESCRIPTION`: what the list returns and how to read a last run.
 * - `AGENT_SCHEDULE_LIST_VIEW`: the tool as a place that may only read the schedules sees it.
 * - `requireAgentScheduleListPage`: the page of a list call; any field of another action is refused.
 */
import { z } from "zod";

import { pageInput, requireOnlyFields } from "../tool-input-validation.js";
import { AGENT_SCHEDULE_LIST_DEFAULT_LIMIT, AGENT_SCHEDULE_LIST_MAX_LIMIT } from "./agent-schedule-config.js";

const INPUT_ERROR_CODE = "AGENT_SCHEDULE_INPUT_INVALID";

export const AGENT_SCHEDULE_LIST_FIELDS = {
  cursor: z.string().min(1).optional().describe("Only in list: nextCursor of the previous page, unchanged."),
  limit: z.number().int().min(1).max(AGENT_SCHEDULE_LIST_MAX_LIMIT).optional().describe("Only in list: the page size."),
};

const LAST_RUN_GUIDANCE =
  "Use the list to check the last run before explaining a failure. lastRun.executionStatus is the execution state, deliveredAt the fact of delivery; completed without deliveredAt means the scenario deliberately stayed silent; taskOutcome=not_verified does not confirm that the requirements were met. diagnostics holds only observed errors, which by themselves do not prove the whole task failed. Take times for the user from nextRunAtLocal and lastRun.scheduledForLocal. skip appears after the person pressed the scenario\'s read button (skip.pressedAt): its runs before skip.until pass without running.";

export const AGENT_SCHEDULE_LIST_DESCRIPTION = [
  "List shows the current user's personal and family agent schedules page by page: {\"action\":\"list\"}; the result is {items,nextCursor}, and a not-null nextCursor goes back unchanged as cursor for the next page.",
  LAST_RUN_GUIDANCE,
].join(" ");

export const AGENT_SCHEDULE_LIST_VIEW = {
  description: [
    "List the current user's personal and family agent schedules page by page: {\"action\":\"list\"}. The result is {items,nextCursor}; a not-null nextCursor goes back unchanged as cursor for the next page. Here the schedules can only be read.",
    LAST_RUN_GUIDANCE,
  ].join(" "),
  inputSchema: z.object({ action: z.enum(["list"]), ...AGENT_SCHEDULE_LIST_FIELDS }).strict(),
};

export function requireAgentScheduleListPage(input: Record<string, unknown>): { cursor?: string; limit: number } {
  requireOnlyFields(input, ["action", "cursor", "limit"], "action=list", INPUT_ERROR_CODE);
  return pageInput(input, INPUT_ERROR_CODE, {
    defaultLimit: AGENT_SCHEDULE_LIST_DEFAULT_LIMIT,
    maxLimit: AGENT_SCHEDULE_LIST_MAX_LIMIT,
  });
}
