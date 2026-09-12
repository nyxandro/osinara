/** Exact recurrence schema shared by trusted and owner-managed external schedule tools. */
import { z } from "zod";
import { AGENT_SCHEDULE_RECURRENCE_INTERVAL_MAX } from "./agent-schedule-config.js";
import { AGENT_SCHEDULE_SIMPLE_RECURRENCE_KINDS } from "./agent-schedule-record.js";

export const agentScheduleRecurrenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once") }).strict(),
  z.object({
    interval: z.number().int().min(1).max(AGENT_SCHEDULE_RECURRENCE_INTERVAL_MAX),
    kind: z.enum(AGENT_SCHEDULE_SIMPLE_RECURRENCE_KINDS),
  }).strict(),
  z.object({
    daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    interval: z.number().int().min(1).max(AGENT_SCHEDULE_RECURRENCE_INTERVAL_MAX),
    kind: z.literal("weekly"),
  }).strict(),
]);
