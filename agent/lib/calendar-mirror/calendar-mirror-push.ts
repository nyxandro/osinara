/**
 * Writes reminder copies to the mirror calendar.
 *
 * Export:
 * - `pushCopies`: brings the calendar to the reminders of the profile — removes events of deleted
 *   reminders, hides copies a reminder no longer has, and creates or replaces the rest.
 *
 * A copy is written with a full replacement: a partial update would keep a repeat the reminder no
 * longer has, and a replacement also brings back a deleted event (both checked live 2026-11-02).
 * A copy never written yet is inserted under its id first; an existing one is replaced first. An
 * event Google refuses is recorded and left until the reminder changes.
 */
import { CalendarCallError, type GoogleCalendarEvent } from "../google-workspace/google-calendar-client.js";
import type { MirrorCopyRow } from "./calendar-mirror-contract.js";
import type { MirrorCycleContext } from "./calendar-mirror-cycle-context.js";
import {
  type CalendarEventBody,
  HIDDEN_COPY_FINGERPRINT,
  HIDING_COPY_FINGERPRINT,
  mirrorEventId,
  type ProjectedCopy,
  projectReminderCopy,
} from "./calendar-mirror-projection.js";

const EVENT_REJECTED_CODE = "AGENT_CALENDAR_MIRROR_EVENT_REJECTED";

function updatedAt(event: GoogleCalendarEvent): Date | null {
  return event.updated ? new Date(event.updated) : null;
}

function isKind(error: unknown, ...kinds: CalendarCallError["kind"][]): boolean {
  return error instanceof CalendarCallError && kinds.includes(error.kind);
}

/** Writes the copy under its event id whatever Google holds there now. */
export async function writeCopyEvent(
  context: MirrorCycleContext,
  copy: Pick<MirrorCopyRow, "eventId" | "fingerprint">,
  body: CalendarEventBody,
): Promise<GoogleCalendarEvent> {
  const fields = body as unknown as Record<string, unknown>;
  const replace = () => context.calendar.updateEvent(context.calendarId, copy.eventId, fields);
  const insert = () => context.calendar.insertEvent(context.calendarId, { ...fields, id: copy.eventId });
  if (copy.fingerprint === null) {
    try {
      return await insert();
    } catch (error) {
      // An interrupted earlier attempt or a deleted copy holds the id: replace what is there.
      if (isKind(error, "conflict")) return await replace();
      throw error;
    }
  }
  try {
    return await replace();
  } catch (error) {
    if (isKind(error, "not_found", "gone")) return await insert();
    throw error;
  }
}

/** Records a written copy; a copy refused by Google is kept aside until its reminder changes. */
export async function storeCopy(
  context: MirrorCycleContext,
  copy: MirrorCopyRow,
  projected: Extract<ProjectedCopy, { hidden: false }>,
): Promise<void> {
  try {
    const event = await writeCopyEvent(context, copy, projected.body);
    await context.repository.recordCopyWritten(copy.id, {
      etag: event.etag ?? null,
      eventUpdated: updatedAt(event),
      fingerprint: projected.fingerprint,
      pushed: projected.pushed,
      seriesStartLocal: projected.seriesStartLocal,
      shown: true,
    });
    context.stats.written += 1;
  } catch (error) {
    if (!isKind(error, "rejected")) throw error;
    const refusal = error as CalendarCallError;
    console.error(JSON.stringify({
      code: EVENT_REJECTED_CODE,
      providerReason: refusal.reason,
      providerStatus: refusal.providerStatus,
      workspaceId: context.profile.workspaceId,
    }));
    await context.repository.recordCopyRejected(copy.id, projected.fingerprint, EVENT_REJECTED_CODE);
    context.stats.rejected += 1;
  }
}

export async function pushCopies(context: MirrorCycleContext): Promise<void> {
  const { repository } = context;
  const reminders = await repository.mirrorReminders(context.profile);
  const copies = await repository.copies(context.profile.workspaceId);
  const copyOf = new Map(copies.filter((copy) => copy.kind === "copy" && copy.reminderId !== null)
    .map((copy) => [copy.reminderId!, copy]));

  for (const orphan of copies.filter((copy) => copy.kind === "copy" && copy.reminderId === null)) {
    await context.calendar.deleteEvent(context.calendarId, orphan.eventId);
    await repository.deleteCopy(orphan.id);
    context.stats.deleted += 1;
  }

  const writes: Array<{ copy: MirrorCopyRow | null; projected: Extract<ProjectedCopy, { hidden: false }>; reminderId: string }> = [];
  for (const reminder of reminders) {
    const copy = copyOf.get(reminder.id) ?? null;
    const projected = projectReminderCopy(reminder, { previous: copy });
    if (projected.hidden) {
      if (copy !== null && (copy.shown || copy.fingerprint === HIDING_COPY_FINGERPRINT)) {
        // Recorded before Google is called: a removal whose answer is lost must not read later as a
        // person deleting the copy, which would delete the reminder.
        await repository.recordCopyHidden(copy.id, HIDING_COPY_FINGERPRINT);
        await context.calendar.deleteEvent(context.calendarId, copy.eventId);
        await repository.recordCopyHidden(copy.id, HIDDEN_COPY_FINGERPRINT);
        context.stats.hidden += 1;
      }
      continue;
    }
    const current = copy !== null && copy.shown && copy.fingerprint === projected.fingerprint;
    const refused = copy !== null && copy.rejectedFingerprint === projected.fingerprint;
    if (!current && !refused) writes.push({ copy, projected, reminderId: reminder.id });
  }

  for (const write of writes) {
    const copy = write.copy ?? await repository.insertPendingCopy(context.profile.workspaceId, write.reminderId, mirrorEventId(write.reminderId));
    await storeCopy(context, copy, write.projected);
  }
}
