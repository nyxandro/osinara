/**
 * PostgreSQL copies of reminders in the mirror calendar, and the reminders a profile mirrors.
 *
 * Export:
 * - `calendarMirrorCopyStore`: the stored link of each calendar event to its reminder, what the bot
 *   last wrote there, and the reminder fields a copy is computed from.
 * - `CopyWrite`: what is recorded after a copy was written to Google.
 */
import { database } from "../database.js";
import type { ReminderRecurrenceUnit, ReminderStatus } from "../reminders/reminder-record.js";
import type {
  CalendarMirrorProfile,
  MirrorCopyRow,
  MirrorReminderSource,
  PushedCopy,
} from "./calendar-mirror-contract.js";

const LOCAL_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS'`;

interface CopyRow {
  etag: string | null;
  event_id: string;
  event_updated: Date | null;
  fingerprint: string | null;
  id: string;
  kind: "copy" | "ignored";
  pushed: PushedCopy | null;
  rejected_fingerprint: string | null;
  reminder_id: string | null;
  series_start_local: string | null;
  shown: boolean;
}

interface ReminderSourceRow {
  anchor_local: string;
  content: string;
  due_local: string;
  id: string;
  quiet_end: string | null;
  quiet_start: string | null;
  recurrence_interval: number | null;
  recurrence_unit: ReminderRecurrenceUnit | null;
  status: ReminderStatus;
  timezone: string;
  updated_at: Date;
}

function toCopy(row: CopyRow): MirrorCopyRow {
  return {
    etag: row.etag,
    eventId: row.event_id,
    eventUpdated: row.event_updated,
    fingerprint: row.fingerprint,
    id: row.id,
    kind: row.kind,
    pushed: row.pushed,
    rejectedFingerprint: row.rejected_fingerprint,
    reminderId: row.reminder_id,
    seriesStartLocal: row.series_start_local,
    shown: row.shown,
  };
}

const COPY_COLUMNS = `id, kind::text AS kind, reminder_id, event_id, etag, event_updated, fingerprint, pushed,
  to_char(series_start_local, ${LOCAL_FORMAT}) AS series_start_local, shown, rejected_fingerprint`;

export interface CopyWrite {
  etag: string | null;
  eventUpdated: Date | null;
  fingerprint: string;
  pushed: PushedCopy | null;
  seriesStartLocal: string | null;
  shown: boolean;
}

export const calendarMirrorCopyStore = {
  /** The live reminders a profile mirrors: personal ones of its owner, or the family's. */
  async mirrorReminders(profile: CalendarMirrorProfile): Promise<MirrorReminderSource[]> {
    const result = await database().query<ReminderSourceRow>(
      `SELECT reminder.id, reminder.content, reminder.timezone, reminder.status::text AS status,
              reminder.recurrence_unit::text AS recurrence_unit, reminder.recurrence_interval,
              reminder.updated_at,
              to_char(reminder.recurrence_anchor_local, ${LOCAL_FORMAT}) AS anchor_local,
              to_char(reminder.due_at AT TIME ZONE reminder.timezone, ${LOCAL_FORMAT}) AS due_local,
              to_char(settings.quiet_start, 'HH24:MI:SS') AS quiet_start,
              to_char(settings.quiet_end, 'HH24:MI:SS') AS quiet_end
       FROM reminders AS reminder
       LEFT JOIN user_notification_settings AS settings ON settings.user_id = reminder.author_user_id
       WHERE reminder.family_id = $1
         AND reminder.status IN ('active', 'leased', 'paused', 'failed')
         AND ((reminder.scope = 'personal' AND $2 = 'personal' AND reminder.owner_user_id = $3)
           OR (reminder.scope = 'family' AND $2 = 'family'))
       ORDER BY reminder.due_at, reminder.id`,
      [profile.familyId, profile.scope, profile.ownerUserId],
    );
    return result.rows.map((row) => ({
      anchorLocal: row.anchor_local,
      content: row.content,
      dueLocal: row.due_local,
      id: row.id,
      quiet: row.quiet_start && row.quiet_end ? { end: row.quiet_end, start: row.quiet_start } : null,
      recurrence: row.recurrence_unit && row.recurrence_interval
        ? { interval: row.recurrence_interval, unit: row.recurrence_unit }
        : null,
      status: row.status,
      timezone: row.timezone,
      updatedAt: row.updated_at,
    }));
  },

  async copies(workspaceId: string): Promise<MirrorCopyRow[]> {
    const result = await database().query<CopyRow>(
      `SELECT ${COPY_COLUMNS} FROM calendar_mirror_copies WHERE workspace_id = $1 ORDER BY created_at, id`,
      [workspaceId],
    );
    return result.rows.map(toCopy);
  },

  /** Records the copy before Google is called, so a lost answer is retried under the same event id. */
  async insertPendingCopy(workspaceId: string, reminderId: string, eventId: string): Promise<MirrorCopyRow> {
    const result = await database().query<CopyRow>(
      `INSERT INTO calendar_mirror_copies (workspace_id, kind, reminder_id, event_id)
       VALUES ($1, 'copy', $2, $3)
       RETURNING ${COPY_COLUMNS}`,
      [workspaceId, reminderId, eventId],
    );
    return toCopy(result.rows[0]!);
  },

  async insertIgnored(workspaceId: string, eventId: string, etag: string | null, eventUpdated: Date | null): Promise<void> {
    await database().query(
      `INSERT INTO calendar_mirror_copies (workspace_id, kind, event_id, etag, event_updated)
       VALUES ($1, 'ignored', $2, $3, $4)
       ON CONFLICT (workspace_id, event_id) DO UPDATE
       SET kind = 'ignored', reminder_id = NULL, etag = EXCLUDED.etag,
           event_updated = EXCLUDED.event_updated, updated_at = now()`,
      [workspaceId, eventId, etag, eventUpdated],
    );
  },

  async recordCopyWritten(copyId: string, write: CopyWrite): Promise<void> {
    await database().query(
      `UPDATE calendar_mirror_copies
       SET etag = $2, event_updated = $3, fingerprint = $4, pushed = $5::jsonb,
           series_start_local = $6::timestamp, shown = $7, rejected_fingerprint = NULL,
           last_error_code = NULL, updated_at = now()
       WHERE id = $1`,
      [
        copyId,
        write.etag,
        write.eventUpdated,
        write.fingerprint,
        write.pushed === null ? null : JSON.stringify(write.pushed),
        write.seriesStartLocal,
        write.shown,
      ],
    );
  },

  /** The bot removed the event because the reminder has no copy now (paused, failed, frequent). */
  async recordCopyHidden(copyId: string, fingerprint: string): Promise<void> {
    await database().query(
      `UPDATE calendar_mirror_copies
       SET shown = false, fingerprint = $2, pushed = NULL, series_start_local = NULL,
           rejected_fingerprint = NULL, last_error_code = NULL, updated_at = now()
       WHERE id = $1`,
      [copyId, fingerprint],
    );
  },

  /** Keeps what Google holds now without a write of the bot, e.g. after a person's edit was applied. */
  async recordCopySeen(copyId: string, etag: string | null, eventUpdated: Date | null): Promise<void> {
    await database().query(
      "UPDATE calendar_mirror_copies SET etag = $2, event_updated = $3, updated_at = now() WHERE id = $1",
      [copyId, etag, eventUpdated],
    );
  },

  async recordCopyRejected(copyId: string, fingerprint: string, errorCode: string): Promise<void> {
    await database().query(
      `UPDATE calendar_mirror_copies
       SET rejected_fingerprint = $2, last_error_code = $3, updated_at = now()
       WHERE id = $1`,
      [copyId, fingerprint, errorCode],
    );
  },

  /** Points a copy at the event that continues its series after a split in Google. */
  async moveCopyToEvent(copyId: string, eventId: string): Promise<void> {
    await database().query(
      "UPDATE calendar_mirror_copies SET event_id = $2, fingerprint = NULL, updated_at = now() WHERE id = $1",
      [copyId, eventId],
    );
  },

  /**
   * Before the calendar is removed for a disconnect: every copy counts as removed by the bot, so a
   * removal cut off halfway never reads as a person's deletes after the same account reconnects.
   */
  async hideAllCopies(workspaceId: string, fingerprint: string): Promise<void> {
    await database().query(
      `UPDATE calendar_mirror_copies
       SET shown = false, fingerprint = $2, pushed = NULL, series_start_local = NULL, updated_at = now()
       WHERE workspace_id = $1 AND kind = 'copy'`,
      [workspaceId, fingerprint],
    );
  },

  async deleteCopy(copyId: string): Promise<void> {
    await database().query("DELETE FROM calendar_mirror_copies WHERE id = $1", [copyId]);
  },

  /**
   * Counts for the model-facing status: reminders still waiting for their copy, and copies Google
   * refused. Frequent, paused and failed reminders have no copy and are not waiting.
   */
  async copyCounts(profile: CalendarMirrorProfile): Promise<{ failed: number; pending: number }> {
    const result = await database().query<{ failed: string; pending: string }>(
      `SELECT
         (SELECT count(*) FROM reminders AS reminder
          WHERE reminder.family_id = $1
            AND ((reminder.scope = 'personal' AND $2 = 'personal' AND reminder.owner_user_id = $3)
              OR (reminder.scope = 'family' AND $2 = 'family'))
            AND reminder.status IN ('active', 'leased')
            AND (reminder.recurrence_unit IS NULL OR reminder.recurrence_unit::text NOT IN ('minutely', 'hourly'))
            AND NOT EXISTS (
              SELECT 1 FROM calendar_mirror_copies AS copy
              WHERE copy.reminder_id = reminder.id
                AND ((copy.shown AND copy.fingerprint IS NOT NULL) OR copy.rejected_fingerprint IS NOT NULL)
            )) AS pending,
         (SELECT count(*) FROM calendar_mirror_copies
          WHERE workspace_id = $4 AND kind = 'copy' AND rejected_fingerprint IS NOT NULL) AS failed`,
      [profile.familyId, profile.scope, profile.ownerUserId, profile.workspaceId],
    );
    return { failed: Number(result.rows[0]!.failed), pending: Number(result.rows[0]!.pending) };
  },
};
