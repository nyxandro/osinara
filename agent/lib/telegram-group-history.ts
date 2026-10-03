/**
 * Safe model-facing Telegram group history application boundary.
 *
 * Exports:
 * - `requireTelegramGroupHistoryAuthorization`: derives group/topic only from current verified auth.
 * - `searchTelegramGroupHistory`: combines trusted scope with bounded model-selected filters.
 */
import type { ToolContext } from "../runtime/tool.js";

import { AppError } from "./app-error.js";
import type {
  TelegramGroupHistorySearchInput,
  TelegramGroupJournalRepository,
} from "./telegram-group-journal-repository.js";
import { visibleTelegramTimelineEntry } from "./telegram-attachment-reference-access.js";
import type { loadCurrentExternalGroupCapabilities } from "./tool-policy/external-group-live-policy.js";

const DEFAULT_HISTORY_LIMIT = 25;

export type TelegramGroupHistoryAuthorization =
  | { familyId: null; groupId: string; groupType: "family_private" }
  | { familyId: string; groupId: string; groupType: "external" };

export function requireTelegramGroupHistoryAuthorization(
  ctx: Pick<ToolContext, "session">,
): TelegramGroupHistoryAuthorization {
  const caller = ctx.session.auth.current;
  const groupId = caller?.attributes.groupId;
  const groupType = caller?.attributes.groupType;
  const familyId = caller?.attributes.familyId;
  if (
    typeof groupId !== "string" ||
    (groupType !== "family_private" && groupType !== "external") ||
    (groupType === "external" && typeof familyId !== "string")
  ) {
    throw new AppError(
      "AGENT_GROUP_HISTORY_SCOPE_DENIED",
      "История группы доступна только внутри текущей зарегистрированной Telegram-группы",
    );
  }
  if (!caller) {
    throw new AppError(
      "AGENT_GROUP_HISTORY_SCOPE_DENIED",
      "История группы доступна только внутри текущей зарегистрированной Telegram-группы",
    );
  }
  if (groupType === "external") {
    // The validated external branch above proves the policy identity required for a live read.
    return { familyId: familyId as string, groupId, groupType };
  }
  return { familyId: null, groupId, groupType };
}

interface GroupHistoryToolInput {
  beforeSequence?: string;
  from?: string;
  limit?: number;
  participant?: string;
  query?: string;
  sequenceFrom?: string;
  sequenceTo?: string;
  to?: string;
}

function optionalDate(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(
      "AGENT_GROUP_HISTORY_DATE_INVALID",
      "Дата для поиска по истории группы указана в неверном формате",
    );
  }
  return parsed;
}

export async function searchTelegramGroupHistory(
  repository: Pick<TelegramGroupJournalRepository, "search">,
  input: GroupHistoryToolInput,
  ctx: Pick<ToolContext, "session">,
  loadExternalCapabilities: typeof loadCurrentExternalGroupCapabilities,
) {
  const authorization = requireTelegramGroupHistoryAuthorization(ctx);
  const query: TelegramGroupHistorySearchInput = {
    allTopics: true,
    anchorEntryId: null,
    beforeSequence: input.beforeSequence ?? null,
    from: optionalDate(input.from),
    groupId: authorization.groupId,
    limit: input.limit ?? DEFAULT_HISTORY_LIMIT,
    messageThreadId: null,
    participant: input.participant ?? null,
    query: input.query ?? null,
    sequenceFrom: input.sequenceFrom ?? null,
    sequenceTo: input.sequenceTo ?? null,
    to: optionalDate(input.to),
  };
  const attachmentReferenceAccess = authorization.groupType === "family_private"
    ? "all" as const
    : await loadExternalCapabilities({
      familyId: authorization.familyId,
      groupId: authorization.groupId,
    }).then((capabilities) => ({
      images: capabilities.has("inspect_workspace_image"),
      readableText: capabilities.has("import_telegram_attachment"),
    }));
  const result = await repository.search(query);
  // Transport and database identifiers stay behind the tool boundary; sequence IDs are the only
  // model-visible addressing scheme.
  return {
    entries: result.entries.map((entry) => {
      const visibleEntry = visibleTelegramTimelineEntry(entry, attachmentReferenceAccess);
      return {
        ...(visibleEntry.attachment === undefined ? {} : { attachment: visibleEntry.attachment }),
        actor: entry.actorKind === "agent_self"
          ? "[agent:self]"
          : entry.actorKind === "telegram_bot" ? "[telegram:bot]" : "[user]",
        content: entry.contentText,
        displayName: entry.senderDisplayName,
        kind: entry.messageKind,
        replyToSequence: entry.replyToSequenceId,
        sentAt: entry.sentAt,
        sequence: entry.sequenceId,
        username: entry.senderUsername,
      };
    }),
    nextBeforeSequence: result.nextBeforeSequence,
  };
}
