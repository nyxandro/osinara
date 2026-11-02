/**
 * The mirror calendar inside the Google connection's own actions.
 *
 * Exports:
 * - `removeCalendarBeforeDisconnect`, `finishDisconnect`: the calendar leaves Google before the
 *   connection's token is deleted; meanwhile the minute cycle writes nothing new.
 * - `calendarMirrorStatus`: the calendar's state for the model's answer about the connection.
 * - `restoreRemindersCalendar`: «Вернуть календарь» after a person deleted it in Google.
 * - `CalendarCleanup`, `CalendarMirrorStatusView`.
 *
 * Removal runs outside the disconnect transaction: the disconnect holds the profile row for update
 * while Google access holds it for share, so nesting them would wait forever. A failed removal does
 * not stop the disconnect; the person is told to delete the calendar or reconnect the same account,
 * whose calendar and copies are kept for that.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { createGoogleCalendarClient } from "../google-workspace/google-calendar-client.js";
import { withGoogleWorkspaceExecutionAccount } from "../google-workspace/google-execution-authorization.js";
import { assertGoogleWorkspaceAccess } from "../google-workspace/google-integration-access.js";
import type { GoogleIntegrationAuthorization } from "../google-workspace/google-integration-contract.js";
import { refreshGoogleAccessToken } from "../google-workspace/google-oauth-client.js";
import { requireGoogleOAuthEnvironment } from "../google-workspace/google-workspace-config.js";
import { removeMirrorCalendar } from "./calendar-mirror-cleanup.js";
import { calendarMirrorCalendarName } from "./calendar-mirror-config.js";
import { HIDDEN_COPY_FINGERPRINT } from "./calendar-mirror-projection.js";
import { calendarMirrorRepository } from "./calendar-mirror-repository.js";

export type CalendarCleanup = "failed" | "kept_with_your_events" | "nothing_to_remove" | "removed";

/** The same live right the disconnect itself checks: a family's Google is managed by its owner. */
async function requireManagementRight(auth: GoogleIntegrationAuthorization): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await assertGoogleWorkspaceAccess(client, auth, true);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function removeCalendarBeforeDisconnect(auth: GoogleIntegrationAuthorization): Promise<CalendarCleanup> {
  // Checked before anything leaves Google: a member who may not disconnect may not remove it either.
  await requireManagementRight(auth);
  const profile = await calendarMirrorRepository.profile(auth.workspaceId);
  if (profile === null) return "nothing_to_remove";
  // The minute cycle stays away until the disconnect ends, so it neither writes nor reports a loss.
  await calendarMirrorRepository.markRemoving(auth.workspaceId);
  if (profile.calendarId === null) return "nothing_to_remove";
  if (profile.state === "stopped_calendar_deleted") {
    // The person already deleted it in Google.
    await calendarMirrorRepository.forgetCalendar(auth.workspaceId, "removing");
    return "nothing_to_remove";
  }
  const calendarId = profile.calendarId;
  // Every copy counts as removed by the bot before Google is called (see `hideAllCopies`).
  await calendarMirrorRepository.hideAllCopies(auth.workspaceId, HIDDEN_COPY_FINGERPRINT);
  try {
    const config = requireGoogleOAuthEnvironment();
    const removal = await withGoogleWorkspaceExecutionAccount(auth, config.encryptionKey, async (account) => {
      if (account === null) {
        throw new AppError("AGENT_GOOGLE_WORKSPACE_PROFILE_NOT_READY", "Профиль Google Workspace не готов");
      }
      const accessToken = (await refreshGoogleAccessToken(config, account.refreshToken)).accessToken;
      return await removeMirrorCalendar(createGoogleCalendarClient(accessToken), calendarId);
    });
    await calendarMirrorRepository.forgetCalendar(auth.workspaceId, "removing");
    return removal;
  } catch (error) {
    // The disconnect the person asked for still happens; the reply tells them what is left.
    console.error(JSON.stringify({
      code: "AGENT_CALENDAR_MIRROR_CLEANUP_FAILED",
      error: error instanceof Error ? error.message : String(error),
      workspaceId: auth.workspaceId,
    }));
    return "failed";
  }
}

/** After the disconnect, or its failure: a profile without an account stays idle, one with it syncs again. */
export async function finishDisconnect(workspaceId: string): Promise<void> {
  const profile = await calendarMirrorRepository.profile(workspaceId);
  if (profile?.state === "removing") await calendarMirrorRepository.setState(workspaceId, "active");
}

export interface CalendarMirrorStatusView {
  calendar: string | null;
  failedCopies: number;
  lastErrorCode: string | null;
  pendingCopies: number;
  state:
    | "active"
    | "catching_up"
    | "not_connected"
    | "removing"
    | "stopped_access_lost"
    | "stopped_calendar_deleted"
    | "stopped_calendar_refused";
}

export async function calendarMirrorStatus(workspaceId: string): Promise<CalendarMirrorStatusView> {
  const profile = await calendarMirrorRepository.profile(workspaceId);
  if (profile === null || profile.integrationAccountId === null) {
    return { calendar: null, failedCopies: 0, lastErrorCode: null, pendingCopies: 0, state: "not_connected" };
  }
  const counts = await calendarMirrorRepository.copyCounts(profile);
  const state = profile.state === "active" && (profile.calendarId === null || counts.pending > 0)
    ? "catching_up"
    : profile.state;
  return {
    calendar: calendarMirrorCalendarName(profile.scope),
    failedCopies: counts.failed,
    lastErrorCode: profile.lastErrorCode,
    pendingCopies: counts.pending,
    state,
  };
}

/** Only the family owner brings back the family calendar; a person brings back their own. */
async function requireRestoreRight(auth: GoogleIntegrationAuthorization): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await assertGoogleWorkspaceAccess(client, auth, false);
    if (auth.scope === "family") {
      const membership = await client.query<{ role: string }>(
        "SELECT role FROM family_memberships WHERE family_id = $1 AND user_id = $2",
        [auth.familyId, auth.userId],
      );
      if (membership.rows[0]?.role !== "owner") {
        throw new AppError("AGENT_OWNER_REQUIRED", "Вернуть семейный календарь напоминаний может только владелец семьи");
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function restoreRemindersCalendar(auth: GoogleIntegrationAuthorization): Promise<CalendarMirrorStatusView> {
  await requireRestoreRight(auth);
  const profile = await calendarMirrorRepository.profile(auth.workspaceId);
  if (profile === null || profile.integrationAccountId === null) {
    throw new AppError(
      "AGENT_GOOGLE_WORKSPACE_NOT_CONNECTED",
      "Google не подключён. Подключите Google, и календарь напоминаний появится сам",
    );
  }
  if (profile.state === "stopped_calendar_deleted" || profile.state === "stopped_calendar_refused") {
    await calendarMirrorRepository.restore(auth.workspaceId);
  }
  return await calendarMirrorStatus(auth.workspaceId);
}
