/**
 * Production wiring of the reminder ↔ Google Calendar mirror.
 *
 * Export:
 * - `productionReconcilerDependencies`: the live Google connection, the Calendar API client,
 *   PostgreSQL storage, Telegram notices and reminder writes.
 *
 * Google access reuses the connection the model uses: the same encrypted refresh token, the same
 * live membership check and the same per-profile lock, taken without waiting so the person goes first.
 */
import { AppError } from "../app-error.js";
import { createGoogleCalendarClient } from "../google-workspace/google-calendar-client.js";
import { tryWithGoogleWorkspaceExecutionAccount } from "../google-workspace/google-execution-authorization.js";
import { refreshGoogleAccessToken } from "../google-workspace/google-oauth-client.js";
import {
  missingGoogleWorkspaceScopes,
  requireGoogleOAuthEnvironment,
} from "../google-workspace/google-workspace-config.js";
import { productionCalendarMirrorNotices } from "./calendar-mirror-notice.js";
import type { ReconcilerDependencies } from "./calendar-mirror-reconciler.js";
import {
  applyCalendarEdit,
  createReminderFromEvent,
  deleteReminderFromCalendar,
} from "./calendar-mirror-reminder-writes.js";
import { calendarMirrorRepository } from "./calendar-mirror-repository.js";

function profileNotReady(): never {
  throw new AppError(
    "AGENT_GOOGLE_WORKSPACE_PROFILE_NOT_READY",
    "Профиль Google Workspace не готов. Подключите аккаунт заново",
  );
}

export function productionReconcilerDependencies(): ReconcilerDependencies {
  return {
    access: {
      async guard(auth, call) {
        const config = requireGoogleOAuthEnvironment();
        return await tryWithGoogleWorkspaceExecutionAccount(auth, config.encryptionKey, async (account) => {
          if (account === null) profileNotReady();
          return await call();
        });
      },
      async token(auth) {
        const config = requireGoogleOAuthEnvironment();
        const result = await tryWithGoogleWorkspaceExecutionAccount(auth, config.encryptionKey, async (account) => {
          if (account === null || missingGoogleWorkspaceScopes(account.scopes).length > 0) profileNotReady();
          return (await refreshGoogleAccessToken(config, account.refreshToken)).accessToken;
        });
        return result.busy ? { busy: true } : { accessToken: result.value, busy: false };
      },
    },
    calendarClient: (accessToken) => createGoogleCalendarClient(accessToken),
    clock: () => Date.now(),
    notices: productionCalendarMirrorNotices,
    repository: calendarMirrorRepository,
    writes: { applyCalendarEdit, createReminderFromEvent, deleteReminderFromCalendar },
  };
}
