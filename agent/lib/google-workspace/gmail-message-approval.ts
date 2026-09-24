/**
 * Trusted Gmail message metadata used only to explain a pending state change.
 *
 * Every provider read is bound to the same verified profile and immutable message IDs as execution.
 */
import type { SessionContext } from "eve/context";
import { z } from "zod";

import { AppError, isAppError } from "../app-error.js";
import { fetchGmailMessageMetadata } from "./gmail-api-client.js";
import type { GoogleIntegrationAuthorization, GoogleIntegrationScope } from "./google-integration-contract.js";
import { resolveGoogleWorkspaceAuthorization } from "./google-workspace-context.js";
import { withAuthorizedGoogleWorkspaceExecution } from "./google-workspace-executor.js";
import type { GoogleWorkspaceExecutionProfile } from "./google-workspace-executor.js";

const GMAIL_SNIPPET_MAX_CHARACTERS = 240;
// Matches the parallelism of gws +triage and stays well inside Gmail's per-user request quota.
const GMAIL_METADATA_CONCURRENCY = 10;

const gmailMessageResponseSchema = z.looseObject({
  id: z.string().min(1),
  payload: z.looseObject({
    headers: z.array(z.looseObject({
      name: z.string(),
      value: z.string(),
    })).optional(),
  }).optional(),
  snippet: z.string().optional(),
});

export interface GmailMessageSummary {
  date: string | null;
  from: string | null;
  id: string;
  snippet: string | null;
  subject: string | null;
}

export interface GmailMessagesApprovalSubject {
  /** Same order and IDs as requested. */
  messages: GmailMessageSummary[];
  profileDisplayName: string;
  profileRef: string;
  scope: GoogleIntegrationScope;
}

interface GmailMessageApprovalDependencies {
  fetchMetadata(accessToken: string, messageId: string, signal: AbortSignal): Promise<unknown>;
  resolveAuthorization(
    ctx: Pick<SessionContext, "session">,
  ): Promise<GoogleIntegrationAuthorization>;
  withAuthorizedExecution<T>(
    auth: GoogleIntegrationAuthorization,
    operation: (
      accessToken: string,
      profile: GoogleWorkspaceExecutionProfile,
    ) => Promise<T>,
  ): Promise<T>;
}

function readable(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized || null;
}

function boundedSnippet(value: string | undefined): string | null {
  const normalized = readable(value);
  if (normalized === null || normalized.length <= GMAIL_SNIPPET_MAX_CHARACTERS) return normalized;
  return `${normalized.slice(0, GMAIL_SNIPPET_MAX_CHARACTERS - 1).trimEnd()}…`;
}

function messageSummary(requestedId: string, payload: unknown): GmailMessageSummary {
  const parsed = gmailMessageResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError(
      "AGENT_GMAIL_APPROVAL_SUBJECT_INVALID",
      "Gmail вернул неполные сведения о письме. Действие не выполнено",
    );
  }
  if (parsed.data.id !== requestedId) {
    throw new AppError(
      "AGENT_GMAIL_APPROVAL_SUBJECT_MISMATCH",
      "Gmail вернул другое письмо. Действие остановлено",
    );
  }
  const headers = parsed.data.payload?.headers ?? [];
  const header = (name: string) => readable(
    headers.find((item) => item.name.toLowerCase() === name)?.value,
  );
  return {
    date: header("date"),
    from: header("from"),
    id: parsed.data.id,
    snippet: boundedSnippet(parsed.data.snippet),
    subject: header("subject"),
  };
}

/** One diagnostic per failed card: parallel reads usually fail together for the same reason. */
function logLoadFailure(error: unknown, messageCount: number): void {
  // A message that is simply gone is an expected state the person is told how to resolve.
  if (isAppError(error) && error.code === "AGENT_GMAIL_APPROVAL_MESSAGE_NOT_FOUND") return;
  const cause = error instanceof Error ? error.cause : undefined;
  console.error(JSON.stringify({
    causeMessage: cause instanceof Error ? cause.message : undefined,
    causeName: cause instanceof Error ? cause.name : undefined,
    code: "AGENT_GMAIL_APPROVAL_SUBJECT_LOAD_FAILED",
    errorCode: isAppError(error) ? error.code : undefined,
    errorName: error instanceof Error ? error.name : "UnknownError",
    messageCount,
  }));
}

/** Loads every message with bounded parallelism; the first failure cancels the rest of the batch. */
async function loadInOrder(
  messageIds: readonly string[],
  load: (messageId: string, signal: AbortSignal) => Promise<GmailMessageSummary>,
): Promise<GmailMessageSummary[]> {
  const controller = new AbortController();
  const results: GmailMessageSummary[] = [];
  const failures: unknown[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (failures.length === 0 && next < messageIds.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await load(messageIds[index]!, controller.signal);
      } catch (error) {
        if (failures.length === 0) {
          failures.push(error);
          controller.abort(error);
        }
        return;
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(GMAIL_METADATA_CONCURRENCY, messageIds.length) },
    worker,
  ));
  if (failures.length > 0) throw failures[0];
  return results;
}

export function createGmailMessageApprovalLoader(
  dependencies: GmailMessageApprovalDependencies,
) {
  return async function loadGmailMessageApproval(
    messageIds: readonly string[],
    expectedProfileRef: string,
    ctx: Pick<SessionContext, "session">,
  ): Promise<GmailMessagesApprovalSubject> {
    const auth = await dependencies.resolveAuthorization(ctx);
    return await dependencies.withAuthorizedExecution(auth, async (accessToken, profile) => {
      if (profile.profileRef !== expectedProfileRef) {
        throw new AppError(
          "AGENT_GOOGLE_WORKSPACE_PROFILE_CHANGED",
          "Подключённый Google-профиль изменился после выбора письма. Повторите запрос",
        );
      }
      let messages: GmailMessageSummary[];
      try {
        messages = await loadInOrder(messageIds, async (messageId, signal) =>
          messageSummary(messageId, await dependencies.fetchMetadata(accessToken, messageId, signal))
        );
      } catch (error) {
        logLoadFailure(error, messageIds.length);
        throw error;
      }
      return {
        messages,
        profileDisplayName: profile.displayName,
        profileRef: profile.profileRef,
        scope: auth.scope,
      };
    });
  };
}

export const loadGmailMessageApproval = createGmailMessageApprovalLoader({
  fetchMetadata: fetchGmailMessageMetadata,
  resolveAuthorization: resolveGoogleWorkspaceAuthorization,
  withAuthorizedExecution: withAuthorizedGoogleWorkspaceExecution,
});
