/**
 * Credentialed Google Workspace execution service shared by model-facing tools.
 *
 * Exports:
 * - `createGoogleWorkspaceExecutor`: injectable live authorization and process boundary.
 * - `executeGoogleWorkspace`: production exact-argv executor.
 *
 * The reminders' calendar-copy (`calendar-mirror`) is kept by the bot: a change the model made there
 * would reach the reminder only a minute later and bypass the reminder tool's checks, so changing it
 * is refused and the model is pointed at manage_reminder. Reading it stays allowed.
 */
import type { ToolContext } from "../../runtime/tool.js";

import { AppError } from "../app-error.js";
import { calendarMirrorRepository } from "../calendar-mirror/calendar-mirror-repository.js";
import { ModelFacingError } from "../model-facing-error.js";
import { withGoogleWorkspaceExecutionAccount } from "./google-execution-authorization.js";
import { classifyGoogleWorkspaceCommand } from "./google-workspace-command-policy.js";
import { runGoogleWorkspaceCommand } from "./google-workspace-command-runner.js";
import type { GoogleIntegrationAuthorization } from "./google-integration-contract.js";
import { resolveGoogleWorkspaceAuthorization } from "./google-workspace-context.js";
import {
  missingGoogleWorkspaceScopes,
  requireGoogleOAuthEnvironment,
} from "./google-workspace-config.js";
import { refreshGoogleAccessToken } from "./google-oauth-client.js";
import { googleWorkspaceProfileStore } from "./google-workspace-profile-store.js";

const MODEL_FACING_OUTPUT_MAX_BYTES = 256 * 1024;

export interface GoogleWorkspaceExecutionProfile {
  profileRef: string;
}

function modelFacingOutput(
  kind: "mutation" | "read",
  result: { stderr: string; stdout: string },
) {
  const byteLength = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
  if (byteLength <= MODEL_FACING_OUTPUT_MAX_BYTES) {
    return { completed: true, stderr: result.stderr, stdout: result.stdout };
  }
  if (kind === "mutation") {
    // The side effect has completed; returning a bounded success cannot invite a duplicate retry.
    return {
      completed: true,
      outputBytes: byteLength,
      outputTruncated: true,
      stderr: "",
      stdout: "",
    };
  }
  throw new AppError(
    "AGENT_GOOGLE_WORKSPACE_OUTPUT_TOO_LARGE",
    "Результат Google Workspace слишком велик. Уточните фильтр, период или размер страницы",
  );
}

/** Calendar sections whose changes act on events or the calendar itself, not on sharing or settings. */
const MIRROR_GUARDED_SECTIONS = new Set(["+insert", "calendars", "events"]);

/**
 * Calendars a calendar change names: `--calendar`, and `calendarId`/`destination` in `--params`,
 * each as a separate value or joined as `--flag=value` (the policy accepts both forms).
 */
export function calendarChangeTargets(argv: readonly string[]): string[] {
  if (argv[0] !== "calendar" || !MIRROR_GUARDED_SECTIONS.has(argv[1] ?? "")) return [];
  const flags: Array<[string, string]> = [];
  for (let index = 0; index < argv.length; index += 1) {
    const element = argv[index]!;
    const joined = /^(--calendar|--params)=(.*)$/su.exec(element);
    if (joined) flags.push([joined[1]!, joined[2]!]);
    else if ((element === "--calendar" || element === "--params") && index + 1 < argv.length) flags.push([element, argv[index + 1]!]);
  }
  const targets: string[] = [];
  for (const [flag, value] of flags) {
    if (flag === "--calendar") {
      targets.push(value);
      continue;
    }
    let params: unknown;
    try {
      params = JSON.parse(value);
    } catch {
      // gws itself refuses malformed parameters; there is no calendar to protect in them.
      continue;
    }
    for (const key of ["calendarId", "destination"]) {
      const target = (params as Record<string, unknown> | null)?.[key];
      if (typeof target === "string") targets.push(target);
    }
  }
  return targets;
}

function mirrorCalendarReadOnly(): ModelFacingError {
  return new ModelFacingError({
    category: "input",
    code: "AGENT_GOOGLE_CALENDAR_MIRROR_READ_ONLY",
    correction: "Чтобы изменить или удалить напоминание, вызови manage_reminder. Календарь-копию бот обновит сам за минуту.",
    reason: "Календарь-копию напоминаний ведёт сам бот: события в нём не меняются напрямую.",
    retryable: false,
    sideEffectStatus: "not_started",
  });
}

interface GoogleWorkspaceExecutorDependencies {
  /** Whether any of these calendars is a reminders' calendar-copy of any profile. */
  isMirrorCalendar(calendarIds: readonly string[]): Promise<boolean>;
  resolveAuthorization(ctx: ToolContext): Promise<GoogleIntegrationAuthorization>;
  run(
    argv: readonly string[],
    kind: "mutation" | "read",
    auth: GoogleIntegrationAuthorization,
    accessToken: string,
    ctx: ToolContext,
  ): ReturnType<typeof runGoogleWorkspaceCommand>;
  withAuthorizedExecution<T>(
    auth: GoogleIntegrationAuthorization,
    operation: (
      accessToken: string,
      profile: GoogleWorkspaceExecutionProfile,
    ) => Promise<T>,
  ): Promise<T>;
}

async function withAuthorizedGoogleWorkspaceExecution<T>(
  auth: GoogleIntegrationAuthorization,
  operation: (
    accessToken: string,
    profile: GoogleWorkspaceExecutionProfile,
  ) => Promise<T>,
): Promise<T> {
  const config = requireGoogleOAuthEnvironment();
  return await withGoogleWorkspaceExecutionAccount(auth, config.encryptionKey, async (account) => {
    const profileExists = await googleWorkspaceProfileStore.exists(auth.workspaceId);
    if (!account || missingGoogleWorkspaceScopes(account.scopes).length > 0 || !profileExists) {
      throw new AppError(
        "AGENT_GOOGLE_WORKSPACE_PROFILE_NOT_READY",
        "Профиль Google Workspace не готов. Подключите аккаунт заново",
      );
    }

    const accessToken = (await refreshGoogleAccessToken(config, account.refreshToken)).accessToken;
    if (!await googleWorkspaceProfileStore.exists(auth.workspaceId)) {
      throw new AppError(
        "AGENT_GOOGLE_WORKSPACE_PROFILE_CHANGED",
        "Профиль Google Workspace изменился во время выполнения запроса. Повторите запрос",
      );
    }
    return await operation(accessToken, { profileRef: account.id });
  });
}

export function createGoogleWorkspaceExecutor(dependencies: GoogleWorkspaceExecutorDependencies) {
  return async function executeGoogleWorkspaceArgv(
    input: { argv: string[]; expectedProfileRef?: string },
    ctx: ToolContext,
  ) {
    // Classification is repeated inside execute so direct/replayed calls cannot bypass policy.
    const kind = classifyGoogleWorkspaceCommand(input.argv);
    if (kind === "mutation") {
      const targets = calendarChangeTargets(input.argv);
      if (targets.length > 0 && await dependencies.isMirrorCalendar(targets)) throw mirrorCalendarReadOnly();
    }
    const auth = await dependencies.resolveAuthorization(ctx);

    // This DB/profile check runs at execution, after any wait for the owner's button.
    return await dependencies.withAuthorizedExecution(auth, async (accessToken, profile) => {
      if (
        input.expectedProfileRef !== undefined &&
        input.expectedProfileRef !== profile.profileRef
      ) {
        throw new AppError(
          "AGENT_GOOGLE_WORKSPACE_PROFILE_CHANGED",
          "Подключённый Google-профиль изменился после выбора объекта. Повторите запрос",
        );
      }
      const result = await dependencies.run(input.argv, kind, auth, accessToken, ctx);
      return {
        kind,
        profileRef: profile.profileRef,
        scope: auth.scope,
        ...modelFacingOutput(kind, result),
      };
    });
  };
}

export const executeGoogleWorkspace = createGoogleWorkspaceExecutor({
  isMirrorCalendar: (calendarIds) => calendarMirrorRepository.isMirrorCalendar(calendarIds),
  resolveAuthorization: resolveGoogleWorkspaceAuthorization,
  run: (argv, kind, auth, accessToken, ctx) =>
    runGoogleWorkspaceCommand(argv, kind, auth, accessToken, ctx),
  withAuthorizedExecution: withAuthorizedGoogleWorkspaceExecution,
});
