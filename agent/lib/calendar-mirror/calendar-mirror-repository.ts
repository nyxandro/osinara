/**
 * PostgreSQL state of the reminder ↔ Google Calendar mirror.
 *
 * Export:
 * - `calendarMirrorRepository`: profile lifecycle (connection, due profiles, failures, stops,
 *   removal, notice recipients) together with the copy store of `calendar-mirror-copy-store.ts`.
 *
 * The mirror owns only its two tables; reminders are read here and changed through
 * `calendar-mirror-reminder-writes.ts`, which keeps the reminder invariants and audit trail.
 */
import type { Pool, PoolClient } from "pg";

import { database } from "../database.js";
import type { FamilyRole } from "../family-access.js";
import type {
  CalendarMirrorActor,
  CalendarMirrorProfile,
  CalendarMirrorScope,
  CalendarMirrorState,
} from "./calendar-mirror-contract.js";
import { calendarMirrorCopyStore } from "./calendar-mirror-copy-store.js";
import type { NoticeRecipient } from "./calendar-mirror-notice.js";

export type { CopyWrite } from "./calendar-mirror-copy-store.js";

type QueryClient = Pick<Pool | PoolClient, "query">;

const PROFILE_COLUMNS = `profile.workspace_id, profile.integration_account_id, profile.external_account_id,
  profile.calendar_id, profile.calendar_marker, profile.sync_token, profile.state::text AS state,
  profile.calendar_missing_since, profile.consecutive_failures, profile.stop_notice_at, profile.last_error_code,
  workspace.family_id, workspace.scope::text AS scope, workspace.owner_user_id`;

interface ProfileRow {
  calendar_id: string | null;
  calendar_marker: string | null;
  calendar_missing_since: Date | null;
  consecutive_failures: number;
  external_account_id: string | null;
  family_id: string;
  integration_account_id: string | null;
  last_error_code: string | null;
  owner_user_id: string | null;
  scope: CalendarMirrorScope;
  state: CalendarMirrorState;
  stop_notice_at: Date | null;
  sync_token: string | null;
  workspace_id: string;
}

interface ActorRow {
  actor_role: FamilyRole | null;
  actor_telegram_user_id: string | null;
  actor_user_id: string | null;
}

function toProfile(row: ProfileRow): CalendarMirrorProfile {
  return {
    calendarId: row.calendar_id,
    calendarMarker: row.calendar_marker,
    calendarMissingSince: row.calendar_missing_since,
    consecutiveFailures: row.consecutive_failures,
    externalAccountId: row.external_account_id,
    familyId: row.family_id,
    integrationAccountId: row.integration_account_id,
    lastErrorCode: row.last_error_code,
    ownerUserId: row.owner_user_id,
    scope: row.scope,
    state: row.state,
    stopNoticeAt: row.stop_notice_at,
    syncToken: row.sync_token,
    workspaceId: row.workspace_id,
  };
}

const calendarMirrorProfileStore = {
  /**
   * Binds the profile to the account just connected. The same Google account keeps its calendar
   * and copies; another account starts from scratch, because the old calendar is not in it.
   */
  async applyConnection(
    client: QueryClient,
    input: { externalAccountId: string; integrationAccountId: string; workspaceId: string },
  ): Promise<void> {
    const previous = await client.query<{ external_account_id: string | null }>(
      "SELECT external_account_id FROM calendar_mirror_profiles WHERE workspace_id = $1 FOR UPDATE",
      [input.workspaceId],
    );
    const sameAccount = previous.rows[0]?.external_account_id === input.externalAccountId;
    if (previous.rows[0] && !sameAccount) {
      await client.query("DELETE FROM calendar_mirror_copies WHERE workspace_id = $1", [input.workspaceId]);
    }
    await client.query(
      `INSERT INTO calendar_mirror_profiles (workspace_id, integration_account_id, external_account_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id) DO UPDATE
       SET integration_account_id = EXCLUDED.integration_account_id,
           external_account_id = EXCLUDED.external_account_id,
           calendar_id = CASE WHEN $4 THEN calendar_mirror_profiles.calendar_id END,
           calendar_marker = CASE WHEN $4 THEN calendar_mirror_profiles.calendar_marker END,
           sync_token = CASE WHEN $4 THEN calendar_mirror_profiles.sync_token END,
           state = 'active', calendar_missing_since = NULL, last_error_code = NULL,
           consecutive_failures = 0, next_attempt_at = NULL, stop_notice_at = NULL, updated_at = now()`,
      [input.workspaceId, input.integrationAccountId, input.externalAccountId, sameAccount],
    );
  },

  /** Profiles whose minute has come, with the member each acts for (null when there is none). */
  async dueProfiles(now: Date): Promise<Array<{ actor: CalendarMirrorActor | null; profile: CalendarMirrorProfile }>> {
    const result = await database().query<ProfileRow & ActorRow>(
      `SELECT ${PROFILE_COLUMNS}, actor.user_id AS actor_user_id, actor.role AS actor_role,
              actor_user.telegram_user_id AS actor_telegram_user_id
       FROM calendar_mirror_profiles AS profile
       JOIN workspaces AS workspace ON workspace.id = profile.workspace_id
       LEFT JOIN LATERAL (
         SELECT membership.user_id, membership.role FROM family_memberships AS membership
         WHERE membership.family_id = workspace.family_id
           AND CASE WHEN workspace.scope = 'personal' THEN membership.user_id = workspace.owner_user_id
                    ELSE membership.role = 'owner' END
         ORDER BY membership.created_at, membership.user_id
         LIMIT 1
       ) AS actor ON true
       LEFT JOIN users AS actor_user ON actor_user.id = actor.user_id
       WHERE profile.integration_account_id IS NOT NULL
         AND profile.state IN ('active', 'removing')
         AND (profile.next_attempt_at IS NULL OR profile.next_attempt_at <= $1)
       ORDER BY profile.next_attempt_at NULLS FIRST, profile.workspace_id`,
      [now],
    );
    return result.rows.map((row) => ({
      actor: row.actor_user_id && row.actor_role && row.actor_telegram_user_id
        ? { role: row.actor_role, telegramUserId: row.actor_telegram_user_id, userId: row.actor_user_id }
        : null,
      profile: toProfile(row),
    }));
  },

  async profile(workspaceId: string, client: QueryClient = database()): Promise<CalendarMirrorProfile | null> {
    const result = await client.query<ProfileRow>(
      `SELECT ${PROFILE_COLUMNS}
       FROM calendar_mirror_profiles AS profile
       JOIN workspaces AS workspace ON workspace.id = profile.workspace_id
       WHERE profile.workspace_id = $1`,
      [workspaceId],
    );
    return result.rows[0] ? toProfile(result.rows[0]) : null;
  },

  async setCalendarMarker(workspaceId: string, marker: string): Promise<void> {
    await database().query(
      "UPDATE calendar_mirror_profiles SET calendar_marker = $2, updated_at = now() WHERE workspace_id = $1",
      [workspaceId, marker],
    );
  },

  async setCalendar(workspaceId: string, calendarId: string): Promise<void> {
    await database().query(
      `UPDATE calendar_mirror_profiles
       SET calendar_id = $2, sync_token = NULL, calendar_missing_since = NULL, updated_at = now()
       WHERE workspace_id = $1`,
      [workspaceId, calendarId],
    );
  },

  async setSyncToken(workspaceId: string, syncToken: string | null): Promise<void> {
    await database().query(
      "UPDATE calendar_mirror_profiles SET sync_token = $2, updated_at = now() WHERE workspace_id = $1",
      [workspaceId, syncToken],
    );
  },

  /** First «no such calendar» answer; returns when it was first seen. */
  async markCalendarMissing(workspaceId: string, now: Date): Promise<Date> {
    const result = await database().query<{ calendar_missing_since: Date }>(
      `UPDATE calendar_mirror_profiles
       SET calendar_missing_since = COALESCE(calendar_missing_since, $2), updated_at = now()
       WHERE workspace_id = $1
       RETURNING calendar_missing_since`,
      [workspaceId, now],
    );
    return result.rows[0]!.calendar_missing_since;
  },

  async recordSuccess(workspaceId: string): Promise<void> {
    await database().query(
      `UPDATE calendar_mirror_profiles
       SET consecutive_failures = 0, next_attempt_at = NULL, last_error_code = NULL,
           calendar_missing_since = NULL, updated_at = now()
       WHERE workspace_id = $1 AND (consecutive_failures <> 0 OR next_attempt_at IS NOT NULL
         OR last_error_code IS NOT NULL OR calendar_missing_since IS NOT NULL)`,
      [workspaceId],
    );
  },

  async recordFailure(workspaceId: string, errorCode: string, nextAttemptAt: Date): Promise<void> {
    await database().query(
      `UPDATE calendar_mirror_profiles
       SET consecutive_failures = consecutive_failures + 1, last_error_code = $2,
           next_attempt_at = $3, updated_at = now()
       WHERE workspace_id = $1`,
      [workspaceId, errorCode, nextAttemptAt],
    );
  },

  /** Defers the rest of the profile's work, e.g. while the model holds the profile. */
  async deferUntil(workspaceId: string, nextAttemptAt: Date): Promise<void> {
    await database().query(
      "UPDATE calendar_mirror_profiles SET next_attempt_at = $2, updated_at = now() WHERE workspace_id = $1",
      [workspaceId, nextAttemptAt],
    );
  },

  /**
   * Stops the mirror in a terminal state; true exactly once per stop, when the person is to be told.
   * The notice mark is set in the same statement, so a retried cycle never tells twice.
   */
  async stop(workspaceId: string, state: Exclude<CalendarMirrorState, "active" | "removing">, errorCode: string): Promise<boolean> {
    const result = await database().query<{ notify: boolean }>(
      `WITH previous AS (
         SELECT stop_notice_at FROM calendar_mirror_profiles WHERE workspace_id = $1 FOR UPDATE
       )
       UPDATE calendar_mirror_profiles AS profile
       SET state = $2::calendar_mirror_state, last_error_code = $3, next_attempt_at = NULL,
           stop_notice_at = COALESCE(profile.stop_notice_at, now()), updated_at = now()
       FROM previous
       WHERE profile.workspace_id = $1
       RETURNING previous.stop_notice_at IS NULL AS notify`,
      [workspaceId, state, errorCode],
    );
    return result.rows[0]?.notify === true;
  },

  /**
   * A disconnect that died between its steps leaves «removing» behind; after this long the profile
   * works again (with its account, it syncs; without, it stays idle).
   */
  async releaseStaleRemoving(now: Date, staleAfterMinutes: number): Promise<void> {
    await database().query(
      `UPDATE calendar_mirror_profiles SET state = 'active', updated_at = now()
       WHERE state = 'removing' AND updated_at < $1::timestamptz - make_interval(mins => $2)`,
      [now, staleAfterMinutes],
    );
  },

  async markRemoving(workspaceId: string): Promise<void> {
    await database().query(
      "UPDATE calendar_mirror_profiles SET state = 'removing', updated_at = now() WHERE workspace_id = $1",
      [workspaceId],
    );
  },

  /** After the calendar was removed from Google: nothing of it is kept. */
  async forgetCalendar(workspaceId: string, state: CalendarMirrorState): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM calendar_mirror_copies WHERE workspace_id = $1", [workspaceId]);
      await client.query(
        `UPDATE calendar_mirror_profiles
         SET calendar_id = NULL, calendar_marker = NULL, sync_token = NULL, calendar_missing_since = NULL,
             state = $2::calendar_mirror_state, updated_at = now()
         WHERE workspace_id = $1`,
        [workspaceId, state],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  /** «Вернуть календарь»: a new calendar and a full transfer on the next cycle. */
  async restore(workspaceId: string): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM calendar_mirror_copies WHERE workspace_id = $1", [workspaceId]);
      await client.query(
        `UPDATE calendar_mirror_profiles
         SET calendar_id = NULL, calendar_marker = NULL, sync_token = NULL, calendar_missing_since = NULL,
             state = 'active', last_error_code = NULL, consecutive_failures = 0, next_attempt_at = NULL,
             stop_notice_at = NULL, updated_at = now()
         WHERE workspace_id = $1`,
        [workspaceId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Chats a notice about the profile goes to: the owner's private chat, or every family group with
   * the family owner as the one who may press its button.
   */
  async noticeRecipients(profile: CalendarMirrorProfile): Promise<NoticeRecipient[]> {
    if (profile.scope === "personal") {
      const owner = await database().query<{ telegram_user_id: string }>(
        `SELECT owner.telegram_user_id FROM users AS owner
         JOIN family_memberships AS membership ON membership.user_id = owner.id AND membership.family_id = $2
         WHERE owner.id = $1`,
        [profile.ownerUserId, profile.familyId],
      );
      const row = owner.rows[0];
      return row
        ? [{ addresseeTelegramUserId: row.telegram_user_id, chatId: row.telegram_user_id, chatType: "private", groupId: null, ownerUserId: profile.ownerUserId }]
        : [];
    }
    const groups = await database().query<{ id: string; owner_telegram_user_id: string; telegram_chat_id: string; telegram_chat_type: "group" | "supergroup" | null }>(
      `SELECT chat.id, chat.telegram_chat_id, chat.telegram_chat_type, owner_user.telegram_user_id AS owner_telegram_user_id
       FROM telegram_groups AS chat
       JOIN LATERAL (
         SELECT membership.user_id FROM family_memberships AS membership
         WHERE membership.family_id = chat.family_id AND membership.role = 'owner'
         ORDER BY membership.created_at, membership.user_id LIMIT 1
       ) AS family_owner ON true
       JOIN users AS owner_user ON owner_user.id = family_owner.user_id
       WHERE chat.family_id = $1 AND chat.type = 'family_private'
       ORDER BY chat.created_at, chat.id`,
      [profile.familyId],
    );
    return groups.rows.map((row) => ({
      addresseeTelegramUserId: row.owner_telegram_user_id,
      chatId: row.telegram_chat_id,
      chatType: row.telegram_chat_type === "group" || row.telegram_chat_type === "supergroup" ? row.telegram_chat_type : null,
      groupId: row.id,
      ownerUserId: null,
    }));
  },

  /**
   * The mirror state of the Google profile a reminder lands in: the person's own for a personal
   * reminder, the family's for a family one; null without a connected Google there.
   */
  async stateFor(input: { familyId: string; scope: CalendarMirrorScope; userId: string }): Promise<CalendarMirrorState | null> {
    const result = await database().query<{ state: CalendarMirrorState }>(
      `SELECT profile.state::text AS state
       FROM calendar_mirror_profiles AS profile
       JOIN workspaces AS workspace ON workspace.id = profile.workspace_id
       WHERE workspace.family_id = $1 AND workspace.scope::text = $2
         AND ($2 = 'family' OR workspace.owner_user_id = $3)
         AND profile.integration_account_id IS NOT NULL`,
      [input.familyId, input.scope, input.userId],
    );
    return result.rows[0]?.state ?? null;
  },

  /** Calendar ids are unique in Google, so a copy of any profile is recognized by its id alone. */
  async isMirrorCalendar(calendarIds: readonly string[]): Promise<boolean> {
    const result = await database().query(
      "SELECT 1 FROM calendar_mirror_profiles WHERE calendar_id = ANY($1::text[]) LIMIT 1",
      [calendarIds],
    );
    return result.rows.length > 0;
  },

  async setState(workspaceId: string, state: CalendarMirrorState): Promise<void> {
    await database().query(
      "UPDATE calendar_mirror_profiles SET state = $2::calendar_mirror_state, updated_at = now() WHERE workspace_id = $1",
      [workspaceId, state],
    );
  },
};

export const calendarMirrorRepository = { ...calendarMirrorProfileStore, ...calendarMirrorCopyStore };
