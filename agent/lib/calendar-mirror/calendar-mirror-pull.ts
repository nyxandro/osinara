/**
 * Takes a person's edits from the mirror calendar into reminders.
 *
 * Export:
 * - `pullChanges`: reads what changed in the calendar since the last sync token and applies it.
 *
 * What changed is told apart by version and content: an event with the etag the bot last wrote or
 * saw, or one that already equals the copy the bot would write now (an answer lost on the way), is
 * the bot's own. A changed copy is compared with what the bot pushed, so a start the copy shows later
 * because of quiet hours is never taken as a new time. Shapes Google produces were checked live on
 * 2026-11-02: a person's deleted or moved run of a series comes with `recurringEventId`; runs Google
 * itself cancels after the series is rewritten come bare, under ids `<series>_<time>`. A series split
 * in Google («this and following») ends the original with UNTIL and continues in a new event; both
 * are taken together in one batch. The sync token moves on only after the whole batch is handled.
 */
import { CalendarCallError, type GoogleCalendarEvent } from "../google-workspace/google-calendar-client.js";
import type { MirrorCopyRow, MirrorReminderSource, PushedCopy } from "./calendar-mirror-contract.js";
import { CALENDAR_MIRROR_EVENT_MINUTES, CALENDAR_MIRROR_PRIVATE_REMINDER } from "./calendar-mirror-config.js";
import { MirrorCalendarRemoved, type MirrorCycleContext, type UnsupportedEditReason } from "./calendar-mirror-cycle-context.js";
import { instantToLocal } from "./calendar-mirror-local-time.js";
import { HIDDEN_COPY_FINGERPRINT, projectReminderCopy } from "./calendar-mirror-projection.js";
import { storeCopy } from "./calendar-mirror-push.js";
import { parseGoogleRecurrence } from "./calendar-mirror-recurrence.js";
import type { CalendarEdit, CalendarSchedule } from "./calendar-mirror-reminder-writes.js";
import { contentFromEvent, contentWithTitle, copyTitle, titleFromSummary } from "./calendar-mirror-text.js";

type Outcome = "done" | "retry";

/**
 * At least this many copies, and at least half of the shown ones, deleted in one batch read as the
 * calendar deleted, not as reminders deleted. Deleting a calendar holding a single copy cannot be
 * told apart from deleting that copy: it deletes that one reminder.
 */
const MASS_DELETION_MIN_COPIES = 2;

interface Split {
  continuation: GoogleCalendarEvent;
  copy: MirrorCopyRow;
  original: GoogleCalendarEvent;
}

interface PullState {
  byEvent: Map<string, MirrorCopyRow>;
  reminders: Map<string, MirrorReminderSource>;
  /** Splits of copied series in this batch, by the id of each of their two events. */
  splits: Map<string, Split>;
  splitsDone: Set<Split>;
}

function updatedOf(event: GoogleCalendarEvent): Date | null {
  return event.updated ? new Date(event.updated) : null;
}

async function listing(context: MirrorCycleContext) {
  try {
    return await context.calendar.listChanges(context.calendarId, context.profile.syncToken);
  } catch (error) {
    if (!(error instanceof CalendarCallError) || error.kind !== "sync_expired") throw error;
    // Google dropped the token: list everything again; known copies are recognized by their etags.
    await context.repository.setSyncToken(context.profile.workspaceId, null);
    return await context.calendar.listChanges(context.calendarId, null);
  }
}

function endsSeries(recurrence: readonly string[] | undefined): boolean {
  return (recurrence ?? []).some((line) => /(?:^|[;:])(?:UNTIL|COUNT)=/u.test(line));
}

/**
 * «This and following» in Google: a copied series ends with UNTIL and a new series continues it
 * in the same batch, carrying the copy's marks or at least its title.
 */
function findSplits(items: readonly GoogleCalendarEvent[], byEvent: Map<string, MirrorCopyRow>): Map<string, Split> {
  const splits = new Map<string, Split>();
  for (const original of items) {
    const copy = byEvent.get(original.id);
    if (copy?.kind !== "copy" || !copy.shown || copy.pushed === null || original.status === "cancelled") continue;
    if (!endsSeries(original.recurrence)) continue;
    const title = titleFromSummary(copy.pushed.summary);
    const continuation = items.find((other) =>
      other.id !== original.id && other.status !== "cancelled" && other.recurringEventId === undefined &&
      !byEvent.has(other.id) && (other.recurrence?.length ?? 0) > 0 &&
      (other.extendedProperties?.private?.[CALENDAR_MIRROR_PRIVATE_REMINDER] === copy.reminderId ||
        titleFromSummary(other.summary) === title));
    if (continuation === undefined) continue;
    const split = { continuation, copy, original };
    splits.set(original.id, split);
    splits.set(continuation.id, split);
  }
  return splits;
}

/** Shown copies deleted in this batch that would delete their reminders (not the bot's own removals). */
function deletedShownCopies(items: readonly GoogleCalendarEvent[], byEvent: Map<string, MirrorCopyRow>, reminders: Map<string, MirrorReminderSource>): number {
  return items.filter((item) => {
    const copy = byEvent.get(item.id);
    if (item.status !== "cancelled" || copy?.kind !== "copy" || !copy.shown || copy.fingerprint === null || copy.reminderId === null) return false;
    const reminder = reminders.get(copy.reminderId);
    return reminder === undefined || !projectReminderCopy(reminder, { previous: copy }).hidden;
  }).length;
}

export async function pullChanges(context: MirrorCycleContext): Promise<void> {
  const changes = await listing(context);
  const copies = await context.repository.copies(context.profile.workspaceId);
  const reminders = await context.repository.mirrorReminders(context.profile);
  const byEvent = new Map(copies.map((copy) => [copy.eventId, copy]));
  const reminderById = new Map(reminders.map((reminder) => [reminder.id, reminder]));
  const shown = copies.filter((copy) => copy.kind === "copy" && copy.shown && copy.fingerprint !== null).length;
  const deleted = deletedShownCopies(changes.items, byEvent, reminderById);
  if (deleted >= MASS_DELETION_MIN_COPIES && deleted * 2 >= shown) {
    // Deleting the calendar deletes all its events at once; a person deleting reminders one by one
    // does not. Every copy counts as gone with the calendar, and no reminder is deleted.
    await context.repository.hideAllCopies(context.profile.workspaceId, HIDDEN_COPY_FINGERPRINT);
    throw new MirrorCalendarRemoved(deleted);
  }
  const state: PullState = {
    byEvent,
    reminders: reminderById,
    splits: findSplits(changes.items, byEvent),
    splitsDone: new Set(),
  };
  let complete = true;
  for (const item of changes.items) {
    context.stats.pulled += 1;
    if (await applyItem(context, state, item) === "retry") complete = false;
  }
  if (complete) await context.repository.setSyncToken(context.profile.workspaceId, changes.nextSyncToken);
}

async function applyItem(context: MirrorCycleContext, state: PullState, item: GoogleCalendarEvent): Promise<Outcome> {
  const split = state.splits.get(item.id);
  if (split !== undefined) return await applySplit(context, state, split);
  const copy = state.byEvent.get(item.id);
  if (item.recurringEventId !== undefined) return await applyRunEdit(context, state, item);
  if (item.status === "cancelled") return await applyDeletion(context, state, copy);
  if (copy?.kind === "copy") {
    if (item.etag === copy.etag || copy.fingerprint === null || !copy.shown) return "done";
    return await applyCopyEdit(context, state, item, copy);
  }
  if (copy?.kind === "ignored" && item.etag === copy.etag) return "done";
  // Any other event, even one carrying old marks (a copy brought back from Google's bin), is the person's.
  return await adoptOwnEvent(context, item);
}

async function applyDeletion(context: MirrorCycleContext, state: PullState, copy: MirrorCopyRow | undefined): Promise<Outcome> {
  if (copy === undefined) return "done";
  if (copy.kind === "ignored") {
    await context.repository.deleteCopy(copy.id);
    return "done";
  }
  // The bot removes copies itself when a reminder is paused or fails; that is not a person's delete.
  if (!copy.shown || copy.fingerprint === null) return "done";
  if (copy.reminderId === null) {
    await context.repository.deleteCopy(copy.id);
    return "done";
  }
  const reminder = state.reminders.get(copy.reminderId);
  if (reminder !== undefined && projectReminderCopy(reminder, { previous: copy }).hidden) {
    // A reminder that has no copy now (paused, failed, frequent): the removal was the bot's own,
    // cut off before it was recorded. A person cannot delete a copy that is not shown.
    await context.repository.recordCopyHidden(copy.id, HIDDEN_COPY_FINGERPRINT);
    return "done";
  }
  const result = await context.writes.deleteReminderFromCalendar({
    actorUserId: context.actor.userId,
    copyId: copy.id,
    familyId: context.profile.familyId,
    reminderId: copy.reminderId,
  });
  if (result === "busy") return "retry";
  context.stats.applied += 1;
  return "done";
}

/** A person moved, renamed or deleted one run of a copied series: the bot has no such exceptions. */
async function applyRunEdit(context: MirrorCycleContext, state: PullState, item: GoogleCalendarEvent): Promise<Outcome> {
  const series = state.byEvent.get(item.recurringEventId!);
  if (series?.kind !== "copy" || !series.shown || series.pushed === null || series.reminderId === null) return "done";
  const original = item.originalStartTime;
  if (!original?.dateTime) return "done";
  const unchanged = item.status !== "cancelled" &&
    item.start?.dateTime !== undefined &&
    new Date(item.start.dateTime).getTime() === new Date(original.dateTime).getTime() &&
    (item.summary === undefined || item.summary === series.pushed.summary);
  if (unchanged) return "done";
  try {
    await context.calendar.patchEvent(context.calendarId, item.id, {
      end: {
        dateTime: new Date(new Date(original.dateTime).getTime() + CALENDAR_MIRROR_EVENT_MINUTES * 60_000).toISOString(),
        timeZone: original.timeZone ?? series.pushed.timeZone,
      },
      start: { dateTime: original.dateTime, timeZone: original.timeZone ?? series.pushed.timeZone },
      status: "confirmed",
      summary: series.pushed.summary,
    });
  } catch (error) {
    if (!(error instanceof CalendarCallError) || error.kind === "transient" || error.kind === "auth") throw error;
    // The run is gone with its series, or Google refuses to put it back: nothing more to do for this
    // run, and a refusal must not hold the whole calendar (a 404 reaching the cycle reads as a
    // deleted calendar). The reminder itself is unchanged.
    console.error(JSON.stringify({
      code: "AGENT_CALENDAR_MIRROR_RUN_RESTORE_FAILED",
      providerReason: error.reason,
      providerStatus: error.providerStatus,
      workspaceId: context.profile.workspaceId,
    }));
    return "done";
  }
  context.stats.reverted += 1;
  await tellUnsupported(context, state.reminders.get(series.reminderId), "instance", series.pushed.summary);
  return "done";
}

async function tellUnsupported(
  context: MirrorCycleContext,
  reminder: MirrorReminderSource | undefined,
  reason: UnsupportedEditReason,
  fallbackSummary: string,
): Promise<void> {
  const title = titleFromSummary(reminder ? copyTitle(reminder.content) : fallbackSummary);
  await context.notices.send(context.profile, { kind: "edit_unsupported", reason, title }, context.now);
}

/** Puts the copy back as the reminder has it and tells the person why. */
async function revert(
  context: MirrorCycleContext,
  copy: MirrorCopyRow,
  reminder: MirrorReminderSource,
  reason: UnsupportedEditReason,
): Promise<Outcome> {
  const projected = projectReminderCopy(reminder, { previous: copy });
  if (projected.hidden) return "done";
  // The event exists in Google, so it is replaced, not inserted.
  await storeCopy(context, { ...copy, fingerprint: copy.fingerprint ?? projected.fingerprint }, projected);
  context.stats.reverted += 1;
  await tellUnsupported(context, reminder, reason, projected.pushed.summary);
  return "done";
}

function sameAsCopy(item: GoogleCalendarEvent, pushed: PushedCopy): boolean {
  return item.start?.dateTime !== undefined &&
    instantToLocal(new Date(item.start.dateTime), pushed.timeZone) === pushed.startLocal &&
    JSON.stringify(item.recurrence ?? null) === JSON.stringify(pushed.recurrence) &&
    (item.summary ?? "") === pushed.summary;
}

/** What a person changed in a copy: the reminder's new text and schedule, or why it cannot follow. */
function editOf(
  item: GoogleCalendarEvent,
  reminder: MirrorReminderSource,
  copy: MirrorCopyRow,
): CalendarEdit | UnsupportedEditReason {
  const pushed = copy.pushed!;
  if (item.start?.dateTime === undefined) return "all_day";
  const startInstant = new Date(item.start.dateTime);
  const startMoved = instantToLocal(startInstant, pushed.timeZone) !== pushed.startLocal;
  const repeatChanged = JSON.stringify(item.recurrence ?? null) !== JSON.stringify(pushed.recurrence);
  const title = titleFromSummary(item.summary);
  // Only the words count: a person who just removed the bell has renamed nothing.
  const renamed = title !== "" && title !== titleFromSummary(pushed.summary);
  const edit: CalendarEdit = {};
  if (renamed) edit.content = contentWithTitle(reminder.content, title);
  if (startMoved || repeatChanged) {
    const schedule = scheduleOf(item, reminder, copy, startMoved ? instantToLocal(startInstant, reminder.timezone) : null);
    if (schedule === null) return "recurrence";
    edit.schedule = schedule;
  }
  return edit;
}

async function applyCopyEdit(
  context: MirrorCycleContext,
  state: PullState,
  item: GoogleCalendarEvent,
  copy: MirrorCopyRow,
): Promise<Outcome> {
  const reminder = copy.reminderId === null ? undefined : state.reminders.get(copy.reminderId);
  const eventUpdated = updatedOf(item);
  if (reminder === undefined) {
    // Delivered, deleted or in another state the calendar does not follow: keep Google's version.
    await context.repository.recordCopySeen(copy.id, item.etag ?? null, eventUpdated);
    return "done";
  }

  const current = projectReminderCopy(reminder, { previous: copy });
  if (!current.hidden && sameAsCopy(item, current.pushed)) {
    // The event already is the copy the bot would write: its own write whose answer was lost.
    await context.repository.recordCopyWritten(copy.id, {
      etag: item.etag ?? null,
      eventUpdated,
      fingerprint: current.fingerprint,
      pushed: current.pushed,
      seriesStartLocal: current.seriesStartLocal,
      shown: true,
    });
    return "done";
  }
  if (!current.hidden && current.fingerprint !== copy.fingerprint && eventUpdated !== null && reminder.updatedAt > eventUpdated) {
    // Both sides changed since the last write: the later change wins, here the reminder's.
    return "done";
  }

  const edit = editOf(item, reminder, copy);
  if (typeof edit === "string") return await revert(context, copy, reminder, edit);
  if (edit.content === undefined && edit.schedule === undefined) {
    await context.repository.recordCopySeen(copy.id, item.etag ?? null, eventUpdated);
    return "done";
  }
  return await applyEdit(context, item, copy, reminder, edit);
}

async function applyEdit(
  context: MirrorCycleContext,
  item: GoogleCalendarEvent,
  copy: MirrorCopyRow,
  reminder: MirrorReminderSource,
  edit: CalendarEdit,
): Promise<Outcome> {
  const eventUpdated = updatedOf(item);
  const result = await context.writes.applyCalendarEdit({
    actorUserId: context.actor.userId,
    copyId: copy.id,
    edit,
    etag: item.etag ?? null,
    eventUpdated,
    familyId: context.profile.familyId,
    now: context.now,
    reminderId: reminder.id,
  });
  if (result === "busy") return "retry";
  if (typeof result === "object") return await revert(context, copy, reminder, result.unsupported);
  if (result === "delivered") await context.repository.recordCopySeen(copy.id, item.etag ?? null, eventUpdated);
  if (result === "applied") context.stats.applied += 1;
  return "done";
}

/**
 * «This and following»: the reminder follows the continuing series, and the original's ended part
 * leaves the calendar, so the person sees one series and gets one message per run.
 */
async function applySplit(context: MirrorCycleContext, state: PullState, split: Split): Promise<Outcome> {
  if (state.splitsDone.has(split)) return "done";
  state.splitsDone.add(split);
  const { continuation, copy, original } = split;
  const reminder = copy.reminderId === null ? undefined : state.reminders.get(copy.reminderId);
  if (reminder === undefined) return "done";
  const edit = editOf(continuation, reminder, copy);
  if (typeof edit === "string") {
    // The continuation repeats in a way the bot cannot: drop it and give the series back whole.
    await context.calendar.deleteEvent(context.calendarId, continuation.id);
    return await revert(context, copy, reminder, edit);
  }
  if (edit.content !== undefined || edit.schedule !== undefined) {
    const outcome = await applyEdit(context, continuation, copy, reminder, edit);
    if (outcome === "retry") {
      state.splitsDone.delete(split);
      return "retry";
    }
  }
  await context.repository.moveCopyToEvent(copy.id, continuation.id);
  await context.calendar.deleteEvent(context.calendarId, original.id);
  return "done";
}

/**
 * The reminder schedule a changed copy asks for, or null when the bot cannot repeat that way.
 * Without a moved start the unshifted start is kept: the copy's start may be delayed by quiet hours.
 */
function scheduleOf(
  item: GoogleCalendarEvent,
  reminder: MirrorReminderSource,
  copy: MirrorCopyRow,
  movedStartLocal: string | null,
): CalendarSchedule | null {
  const repeats = item.recurrence !== undefined && item.recurrence.length > 0;
  const startLocal = movedStartLocal ?? (repeats ? copy.seriesStartLocal ?? reminder.dueLocal : reminder.dueLocal);
  const recurrence = parseGoogleRecurrence(item.recurrence, startLocal);
  if (recurrence.kind === "unsupported") return null;
  return { recurrence: recurrence.kind === "none" ? null : recurrence, startLocal };
}

/** A person's own event in the mirror calendar becomes a reminder, or is set aside with a message. */
async function adoptOwnEvent(context: MirrorCycleContext, item: GoogleCalendarEvent): Promise<Outcome> {
  const start = item.start?.dateTime !== undefined
    ? { instant: new Date(item.start.dateTime) }
    : item.start?.date !== undefined ? { allDayDate: item.start.date } : null;
  const content = contentFromEvent(item.summary, item.description);
  const setAside = async () => {
    await context.repository.insertIgnored(context.profile.workspaceId, item.id, item.etag ?? null, updatedOf(item));
    context.stats.ignored += 1;
  };
  // Without a time or any words there is nothing to remind of; nothing is made up for it.
  if (start === null || content === null) {
    await setAside();
    return "done";
  }
  // Google writes the start in the event's own zone; its wall-clock part names the weekday and day.
  const startLocal = "instant" in start ? item.start!.dateTime!.slice(0, 19) : `${start.allDayDate}T00:00:00`;
  const recurrence = parseGoogleRecurrence(item.recurrence, startLocal);
  if (recurrence.kind === "unsupported") {
    await setAside();
    await context.notices.send(context.profile, { kind: "event_unsupported", title: content.split("\n")[0]! }, context.now);
    return "done";
  }
  const result = await context.writes.createReminderFromEvent({
    actor: context.actor,
    content,
    etag: item.etag ?? null,
    eventId: item.id,
    eventUpdated: updatedOf(item),
    now: context.now,
    profile: context.profile,
    recurrence: recurrence.kind === "none" ? null : recurrence,
    start,
  });
  if (typeof result === "object") {
    context.stats.created += 1;
    return "done";
  }
  await setAside();
  if (result === "settings_missing") {
    await context.notices.send(context.profile, { kind: "settings_missing" }, context.now);
  } else if (result === "no_family_group") {
    console.error(JSON.stringify({ code: "AGENT_CALENDAR_MIRROR_FAMILY_GROUP_MISSING", workspaceId: context.profile.workspaceId }));
  }
  return "done";
}
