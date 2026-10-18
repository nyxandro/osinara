/**
 * How often the family's skills are used, read from the turn journal rather than kept separately.
 *
 * Export:
 * - `familySkillUsage`: per skill name, successful `load_skill` calls in the family's conversations
 *   over the last 30 days and the time of the latest one.
 *
 * Every tool call is already journaled (`agent_tool_calls`) with the turn's verified auth, so a load
 * needs no second record. The journal keeps every turn; if it ever gets a retention window, usage
 * older than that window is gone with it.
 */
import { database } from "../database.js";

const USAGE_WINDOW_DAYS = 30;

export interface SkillUsage {
  readonly lastLoadedAt: Date | null;
  readonly loads: number;
}

export async function familySkillUsage(familyId: string, names: readonly string[]): Promise<ReadonlyMap<string, SkillUsage>> {
  if (names.length === 0) return new Map();
  const rows = (await database().query<{ last_loaded_at: Date; loads: number; name: string }>(
    `SELECT call.input->>'skill' AS name, count(*)::integer AS loads, max(call.created_at) AS last_loaded_at
       FROM agent_tool_calls call
       JOIN agent_turns turn ON turn.id = call.turn_id
      WHERE call.tool_name = 'load_skill' AND call.state = 'completed'
        AND call.created_at > now() - make_interval(days => $3)
        AND coalesce(call.output->>'type', '') NOT LIKE 'error%'
        AND turn.auth->'current'->'attributes'->>'familyId' = $1
        AND call.input->>'skill' = ANY($2::text[])
      GROUP BY 1`,
    [familyId, [...names], USAGE_WINDOW_DAYS],
  )).rows;
  const usage = new Map(rows.map((row) => [row.name, { lastLoadedAt: row.last_loaded_at, loads: row.loads }]));
  return new Map(names.map((name) => [name, usage.get(name) ?? { lastLoadedAt: null, loads: 0 }]));
}
