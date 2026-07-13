/**
 * PostgreSQL typed behavior preference boundary.
 *
 * Exports:
 * - `BehaviorPreferenceItem`: safe stored preference projection.
 * - `behaviorPreferenceRepository`: scoped list, set, and delete operations.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";

export interface BehaviorPreferenceItem {
  key: string;
  scope: MemoryScope;
  updatedAt: string;
  value: string;
}

function requirePreferenceScope(auth: MemoryAuthorization, scope: MemoryScope): void {
  if (!auth.scopes.includes(scope)) {
    throw new AppError("AGENT_MEMORY_SCOPE_DENIED", "Эта информация недоступна в текущем чате");
  }
  if (scope === "personal" && !auth.userId) {
    throw new AppError("AGENT_MEMORY_CONTEXT_INVALID", "Не удалось определить владельца настройки");
  }
  if (scope === "group" && !auth.groupId) {
    throw new AppError("AGENT_MEMORY_CONTEXT_INVALID", "Не удалось определить группу настройки");
  }
}

export const behaviorPreferenceRepository = {
  async delete(auth: MemoryAuthorization, scope: MemoryScope, preference: string): Promise<boolean> {
    requirePreferenceScope(auth, scope);
    const result = await database().query(
      `DELETE FROM behavior_preferences
       WHERE family_id = $1 AND scope = $2 AND preference = $3
         AND ($2 <> 'personal' OR owner_user_id = $4)
         AND ($2 <> 'group' OR group_id = $5)`,
      [auth.familyId, scope, preference, auth.userId, auth.groupId],
    );
    return Boolean(result.rowCount);
  },

  async list(auth: MemoryAuthorization): Promise<BehaviorPreferenceItem[]> {
    const result = await database().query<{
      preference: string;
      scope: MemoryScope;
      updated_at: Date;
      value: string;
    }>(
      `SELECT preference, value, scope, updated_at
       FROM behavior_preferences
       WHERE family_id = $1
         AND (
           (scope = 'personal' AND 'personal' = ANY($2::memory_scope[]) AND owner_user_id = $3) OR
           (scope = 'family' AND 'family' = ANY($2::memory_scope[])) OR
           (scope = 'group' AND 'group' = ANY($2::memory_scope[]) AND group_id = $4)
         )
       ORDER BY updated_at DESC`,
      [auth.familyId, auth.scopes, auth.userId, auth.groupId],
    );
    return result.rows.map((row) => ({
      key: `agent.behavior.${row.preference}`,
      scope: row.scope,
      updatedAt: row.updated_at.toISOString(),
      value: row.value,
    }));
  },

  async set(
    auth: MemoryAuthorization,
    input: { preference: string; scope: MemoryScope; value: string },
  ): Promise<BehaviorPreferenceItem> {
    requirePreferenceScope(auth, input.scope);
    const ownerUserId = input.scope === "personal" ? auth.userId : null;
    const groupId = input.scope === "group" ? auth.groupId : null;
    const conflict =
      input.scope === "personal"
        ? "(family_id, owner_user_id, preference) WHERE scope = 'personal'"
        : input.scope === "family"
          ? "(family_id, preference) WHERE scope = 'family'"
          : "(family_id, group_id, preference) WHERE scope = 'group'";
    const result = await database().query<{
      preference: string;
      scope: MemoryScope;
      updated_at: Date;
      value: string;
    }>(
      `INSERT INTO behavior_preferences
         (family_id, owner_user_id, group_id, scope, preference, value)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT ${conflict}
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       RETURNING preference, value, scope, updated_at`,
      [auth.familyId, ownerUserId, groupId, input.scope, input.preference, input.value],
    );
    const row = result.rows[0];
    if (!row) throw new Error("AGENT_PREFERENCE_WRITE_FAILED: Настройка не была сохранена");
    return {
      key: `agent.behavior.${row.preference}`,
      scope: row.scope,
      updatedAt: row.updated_at.toISOString(),
      value: row.value,
    };
  },
};
