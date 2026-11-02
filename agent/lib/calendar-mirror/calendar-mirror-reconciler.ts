/**
 * One minute of the reminder ↔ Google Calendar mirror for every connected Google profile.
 *
 * Exports:
 * - `reconcileCalendarMirrors`: for each due profile — a token, the calendar (created once), a
 *   person's edits taken in, then the reminders written out.
 * - `ReconcilerDependencies`: storage, Google access, the calendar client, notices and writes.
 *
 * Every Google call takes the profile without waiting: when the model is using it, the rest of the
 * work waits for the next minute, so a person never waits behind the mirror for more than one call.
 * A cycle also stops after its write and time budget. Neither counts as a failure. Lost access, a
 * calendar gone for good and a calendar Google refuses stop the mirror and tell the person once;
 * temporary failures back off up to an hour.
 */
import { randomUUID } from "node:crypto";

import { isAppError } from "../app-error.js";
import { CalendarCallError, type GoogleCalendarClient } from "../google-workspace/google-calendar-client.js";
import type { GoogleIntegrationAuthorization } from "../google-workspace/google-integration-contract.js";
import type { CalendarMirrorActor, CalendarMirrorProfile } from "./calendar-mirror-contract.js";
import {
  CALENDAR_MIRROR_BACKOFF_MAX_MINUTES,
  CALENDAR_MIRROR_CALENDAR_GONE_CONFIRM_MINUTES,
  CALENDAR_MIRROR_PROFILE_BUDGET_MS,
  CALENDAR_MIRROR_REMOVING_STALE_MINUTES,
  CALENDAR_MIRROR_WRITES_PER_TICK,
  calendarMirrorCalendarDescription,
  calendarMirrorCalendarName,
} from "./calendar-mirror-config.js";
import {
  type CycleStats,
  MirrorCalendarRemoved,
  MirrorCycleDeferred,
  type MirrorNotices,
  type MirrorRepository,
  type MirrorWrites,
  newCycleStats,
} from "./calendar-mirror-cycle-context.js";
import { pullChanges } from "./calendar-mirror-pull.js";
import { pushCopies } from "./calendar-mirror-push.js";
import type { calendarMirrorRepository } from "./calendar-mirror-repository.js";

const ACCESS_LOST_CODE = "AGENT_CALENDAR_MIRROR_ACCESS_LOST";
const ACCESS_LOST_APP_CODES = new Set([
  "AGENT_GOOGLE_AUTH_EXPIRED",
  "AGENT_GOOGLE_SCOPE_MISSING",
  "AGENT_GOOGLE_WORKSPACE_ACCESS_DENIED",
  "AGENT_GOOGLE_WORKSPACE_PROFILE_NOT_READY",
]);

export type MirrorCalendarClient = Pick<
  GoogleCalendarClient,
  "deleteEvent" | "findCalendarByMarker" | "insertCalendar" | "insertEvent" | "listChanges" | "patchEvent" | "updateEvent"
>;

export interface ReconcilerDependencies {
  access: {
    /** One Google call under the profile, not waiting for it. */
    guard<T>(auth: GoogleIntegrationAuthorization, call: () => Promise<T>): Promise<{ busy: true } | { busy: false; value: T }>;
    /** A fresh access token of the profile's Google connection, not waiting for the profile. */
    token(auth: GoogleIntegrationAuthorization): Promise<{ busy: true } | { accessToken: string; busy: false }>;
  };
  calendarClient(accessToken: string): MirrorCalendarClient;
  /** Milliseconds, for the cycle budget. */
  clock(): number;
  notices: MirrorNotices;
  repository: MirrorRepository & Pick<
    typeof calendarMirrorRepository,
    "deferUntil" | "dueProfiles" | "markCalendarMissing" | "recordFailure" | "recordSuccess" | "releaseStaleRemoving" | "setCalendar" | "setCalendarMarker" | "stop"
  >;
  writes: MirrorWrites;
}

function authorizationOf(profile: CalendarMirrorProfile, actor: CalendarMirrorActor): GoogleIntegrationAuthorization {
  return {
    familyId: profile.familyId,
    role: actor.role,
    scope: profile.scope,
    telegramUserId: actor.telegramUserId,
    userId: actor.userId,
    workspaceId: profile.workspaceId,
  };
}

const WRITE_METHODS = new Set(["deleteEvent", "insertCalendar", "insertEvent", "patchEvent", "updateEvent"]);

/** The calendar client of one cycle: every call under the profile, within the cycle's budget. */
function guardedClient(
  dependencies: ReconcilerDependencies,
  auth: GoogleIntegrationAuthorization,
  client: MirrorCalendarClient,
): MirrorCalendarClient {
  const started = dependencies.clock();
  let writes = 0;
  const guarded = {} as Record<string, unknown>;
  for (const [name, method] of Object.entries(client) as Array<[string, (...args: unknown[]) => Promise<unknown>]>) {
    const write = WRITE_METHODS.has(name);
    guarded[name] = async (...args: unknown[]) => {
      if (dependencies.clock() - started >= CALENDAR_MIRROR_PROFILE_BUDGET_MS) throw new MirrorCycleDeferred("budget");
      if (write && writes >= CALENDAR_MIRROR_WRITES_PER_TICK) throw new MirrorCycleDeferred("budget");
      const result = await dependencies.access.guard(auth, () => method.apply(client, args));
      if (result.busy) throw new MirrorCycleDeferred("busy");
      if (write) writes += 1;
      return result.value;
    };
  }
  return guarded as unknown as MirrorCalendarClient;
}

/** The profile's calendar: known, found by its marker after a lost answer, or created now. */
async function ensureCalendar(
  dependencies: ReconcilerDependencies,
  profile: CalendarMirrorProfile,
  client: MirrorCalendarClient,
): Promise<string> {
  if (profile.calendarId !== null) return profile.calendarId;
  const { repository } = dependencies;
  if (profile.calendarMarker !== null) {
    const found = await client.findCalendarByMarker(profile.calendarMarker);
    if (found !== null) {
      await repository.setCalendar(profile.workspaceId, found);
      return found;
    }
  }
  // A new marker each time: a calendar deleted before may still be listed while Google removes it.
  const marker = `osinara-mirror:${profile.workspaceId}:${randomUUID()}`;
  await repository.setCalendarMarker(profile.workspaceId, marker);
  try {
    const created = await client.insertCalendar({
      description: calendarMirrorCalendarDescription(marker),
      summary: calendarMirrorCalendarName(profile.scope),
    });
    await repository.setCalendar(profile.workspaceId, created.id);
    return created.id;
  } catch (error) {
    if (error instanceof CalendarCallError && error.kind === "rejected") throw new CalendarRefused(error);
    throw error;
  }
}

class CalendarRefused extends Error {
  constructor(readonly refusal: CalendarCallError) {
    super(`AGENT_CALENDAR_MIRROR_CALENDAR_REFUSED: ${refusal.message}`);
    this.name = "CalendarRefused";
  }
}

async function stopAndTell(
  dependencies: ReconcilerDependencies,
  profile: CalendarMirrorProfile,
  now: Date,
  stop: { code: string; notice: "access_lost" | "calendar_deleted" | "calendar_refused" | null; state: "stopped_access_lost" | "stopped_calendar_deleted" | "stopped_calendar_refused" },
): Promise<void> {
  const first = await dependencies.repository.stop(profile.workspaceId, stop.state, stop.code);
  console.error(JSON.stringify({ code: stop.code, scope: profile.scope, state: stop.state, workspaceId: profile.workspaceId }));
  if (first && stop.notice !== null) await dependencies.notices.send(profile, { kind: stop.notice }, now);
}

async function handleFailure(
  dependencies: ReconcilerDependencies,
  profile: CalendarMirrorProfile,
  now: Date,
  error: unknown,
): Promise<void> {
  const { repository } = dependencies;
  if (error instanceof MirrorCalendarRemoved) {
    await stopAndTell(dependencies, profile, now, {
      code: "AGENT_CALENDAR_MIRROR_CALENDAR_DELETED",
      notice: "calendar_deleted",
      state: "stopped_calendar_deleted",
    });
    return;
  }
  if (error instanceof CalendarRefused) {
    await stopAndTell(dependencies, profile, now, {
      code: "AGENT_CALENDAR_MIRROR_CALENDAR_REFUSED",
      notice: "calendar_refused",
      state: "stopped_calendar_refused",
    });
    return;
  }
  const accessLost = (isAppError(error) && ACCESS_LOST_APP_CODES.has(error.code)) ||
    (error instanceof CalendarCallError && error.kind === "auth");
  if (accessLost) {
    await stopAndTell(dependencies, profile, now, { code: ACCESS_LOST_CODE, notice: "access_lost", state: "stopped_access_lost" });
    return;
  }
  if (error instanceof CalendarCallError && error.kind === "not_found") {
    // Google keeps a deleted calendar readable for minutes; only a lasting absence means deleted.
    const since = await repository.markCalendarMissing(profile.workspaceId, now);
    const confirmAt = since.getTime() + CALENDAR_MIRROR_CALENDAR_GONE_CONFIRM_MINUTES * 60_000;
    if (now.getTime() >= confirmAt) {
      await stopAndTell(dependencies, profile, now, {
        code: "AGENT_CALENDAR_MIRROR_CALENDAR_DELETED",
        notice: "calendar_deleted",
        state: "stopped_calendar_deleted",
      });
    } else {
      await repository.deferUntil(profile.workspaceId, new Date(confirmAt));
    }
    return;
  }
  const temporary = error instanceof CalendarCallError && error.kind === "transient";
  const minutes = Math.min(2 ** profile.consecutiveFailures, CALENDAR_MIRROR_BACKOFF_MAX_MINUTES);
  const code = temporary ? "AGENT_CALENDAR_MIRROR_PROVIDER_UNAVAILABLE" : "AGENT_CALENDAR_MIRROR_CYCLE_FAILED";
  console.error(JSON.stringify({
    code,
    error: error instanceof Error ? error.message : String(error),
    providerReason: error instanceof CalendarCallError ? error.reason : null,
    providerStatus: error instanceof CalendarCallError ? error.providerStatus : null,
    retryInMinutes: minutes,
    workspaceId: profile.workspaceId,
  }));
  await repository.recordFailure(profile.workspaceId, code, new Date(now.getTime() + minutes * 60_000));
}

function logCycle(profile: CalendarMirrorProfile, stats: CycleStats, deferred: MirrorCycleDeferred | null): void {
  const busy = Object.values(stats).some((value) => value > 0);
  if (!busy && deferred === null) return;
  console.log(JSON.stringify({
    code: "AGENT_CALENDAR_MIRROR_RECONCILED",
    deferred: deferred?.why ?? null,
    scope: profile.scope,
    workspaceId: profile.workspaceId,
    ...stats,
  }));
}

async function reconcileProfile(
  dependencies: ReconcilerDependencies,
  entry: { actor: CalendarMirrorActor | null; profile: CalendarMirrorProfile },
  now: Date,
): Promise<void> {
  const { actor, profile } = entry;
  // The disconnect in progress removes the calendar itself; nothing new is written meanwhile.
  if (profile.state === "removing") return;
  if (actor === null) {
    await stopAndTell(dependencies, profile, now, { code: ACCESS_LOST_CODE, notice: null, state: "stopped_access_lost" });
    return;
  }
  const stats = newCycleStats();
  try {
    const auth = authorizationOf(profile, actor);
    const token = await dependencies.access.token(auth);
    if (token.busy) return;
    const calendar = guardedClient(dependencies, auth, dependencies.calendarClient(token.accessToken));
    const calendarId = await ensureCalendar(dependencies, profile, calendar);
    const context = {
      actor,
      calendar,
      calendarId,
      notices: dependencies.notices,
      now,
      profile: { ...profile, calendarId },
      repository: dependencies.repository,
      stats,
      writes: dependencies.writes,
    };
    await pullChanges(context);
    await pushCopies(context);
    await dependencies.repository.recordSuccess(profile.workspaceId);
    logCycle(profile, stats, null);
  } catch (error) {
    if (error instanceof MirrorCycleDeferred) {
      logCycle(profile, stats, error);
      return;
    }
    await handleFailure(dependencies, profile, now, error);
  }
}

export async function reconcileCalendarMirrors(dependencies: ReconcilerDependencies, now: Date): Promise<void> {
  await dependencies.repository.releaseStaleRemoving(now, CALENDAR_MIRROR_REMOVING_STALE_MINUTES);
  const due = await dependencies.repository.dueProfiles(now);
  for (const entry of due) {
    try {
      await reconcileProfile(dependencies, entry, now);
    } catch (error) {
      // One profile's storage failure must not stop the others; the next minute retries it.
      console.error(JSON.stringify({
        code: "AGENT_CALENDAR_MIRROR_PROFILE_FAILED",
        error: error instanceof Error ? error.message : String(error),
        workspaceId: entry.profile.workspaceId,
      }));
    }
  }
}
