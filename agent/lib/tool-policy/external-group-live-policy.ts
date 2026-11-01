/**
 * Current external-group capability policy.
 *
 * Export:
 * - `loadCurrentExternalGroupCapabilities`: reads and validates the current PostgreSQL allowlist.
 * - `authorizeCurrentExternalGroupCapability`: records the execution-time authorization boundary.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import {
  parseExternalGroupToolAllowlist,
  type ExternalGroupToolName,
} from "./group-tool-catalog.js";

export async function loadCurrentExternalGroupCapabilities(input: {
  familyId: string;
  groupId: string;
}): Promise<ReadonlySet<ExternalGroupToolName>> {
  const result = await database().query<{ tool_allowlist: string[] }>(
    `SELECT tool_allowlist
       FROM telegram_groups
      WHERE id = $1
        AND family_id = $2
        AND type = 'external'`,
    [input.groupId, input.familyId],
  );
  const registration = result.rows[0];
  if (!registration) {
    throw new AppError(
      "AGENT_GROUP_REGISTRATION_INVALID",
      "Текущая регистрация внешней группы больше не действует",
    );
  }
  const allowed = parseExternalGroupToolAllowlist(registration.tool_allowlist);
  if (!allowed) {
    throw new AppError(
      "AGENT_GROUP_TOOL_POLICY_INVALID",
      "Политика инструментов внешней группы повреждена. Обратитесь к владельцу агента",
    );
  }

  return allowed;
}

export async function authorizeCurrentExternalGroupCapability(
  input: { familyId: string; groupId: string },
  capability: ExternalGroupToolName,
): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ tool_allowlist: string[] }>(
      `SELECT tool_allowlist
         FROM telegram_groups
        WHERE id = $1 AND family_id = $2 AND type = 'external'
        FOR SHARE`,
      [input.groupId, input.familyId],
    );
    const allowed = parseExternalGroupToolAllowlist(result.rows[0]?.tool_allowlist);
    if (!allowed?.has(capability)) {
      throw new AppError(
        "AGENT_GROUP_TOOL_FORBIDDEN",
        "Этот инструмент не разрешён в текущей внешней группе. Обратитесь к владельцу агента",
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
