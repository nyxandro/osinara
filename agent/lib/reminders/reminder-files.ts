/**
 * Workspace files shown inside a reminder's text.
 *
 * Exports:
 * - `requireReminderFiles`: refuses a reminder text whose files will not reach its chat, for the
 *   tool that writes it.
 * - `reminderWriterRights`: the rights a family member writing a reminder has to their own folders.
 * - `reminderWorkspaceAuthorization`: the rights a reminder's files are read with when it goes out.
 * - `prepareReminderFiles`: the reminder's text with its files read and laid out for delivery.
 *
 * Key constructs:
 * - A reminder goes out later without the model, so its files are checked when it is written: with
 *   the rights of the person writing it, against the folders of the chat it will reach, whichever
 *   chat it is written from.
 * - At delivery the files are read with the rights of the reminder's author, re-checked on every
 *   read, since the author may have left the family meanwhile. A public chat's reminder reads only
 *   that chat's own folder. A file that cannot go leaves a visible line with its reason.
 * - The reminder is already marked as being sent when its files are read, and such a reminder is
 *   never sent again: files that cannot be read at all leave a line each, and the text goes on time.
 */
import { reminderFilesError } from "../answer-files/answer-file-check.js";
import {
  prepareAnswerFiles,
  unreadAnswerFiles,
  type PreparedTelegramAnswer,
} from "../answer-files/answer-file-delivery.js";
import { answerFileResolver } from "../answer-files/answer-file-resolution.js";
import { AppError, isAppError } from "../app-error.js";
import { toolInputError } from "../tool-input-validation.js";
import type { WorkspaceScope } from "../workspaces/workspace-file-record.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import type { ReminderAuthorization } from "./reminder-context.js";
import type { ClaimedReminder } from "./reminder-dispatch-repository.js";
import type { ReminderScope } from "./reminder-record.js";

// The folders the chat a reminder reaches may show: a private chat both of its person's, a family
// group the family's, a public chat only its own.
const REMINDER_FILE_SCOPES: Readonly<Record<ReminderScope, readonly WorkspaceScope[]>> = {
  family: ["family"],
  group: ["group"],
  personal: ["personal", "family"],
};
const GROUP_CHAT_TYPES: ReadonlySet<string> = new Set(["group", "supergroup"]);

export async function requireReminderFiles(input: {
  readonly content: string;
  readonly errorCode: string;
  /** The writer's rights; the reminder's scope limits which of their folders it may show. */
  readonly rights: () => WorkspaceAuthorization | null;
  readonly scope: ReminderScope;
}): Promise<void> {
  const error = await reminderFilesError({
    allowedScopes: REMINDER_FILE_SCOPES[input.scope],
    auth: input.rights,
    resolver: answerFileResolver,
    text: input.content,
  });
  if (error !== undefined) toolInputError(input.errorCode, error);
}

/**
 * A member's rights as in their private chat, where both their folders open. The chat a reminder is
 * changed from may be the family group, while the reminder still reaches the private chat.
 */
export function reminderWriterRights(auth: ReminderAuthorization): WorkspaceAuthorization {
  return {
    familyId: auth.familyId,
    groupId: null,
    groupType: null,
    role: auth.role,
    telegramChatType: "private",
    userId: auth.userId,
  };
}

function invalidContext(job: Pick<ClaimedReminder, "id">): never {
  throw new AppError(
    "AGENT_REMINDER_FILES_CONTEXT_INVALID",
    `Не удалось определить, чьими правами читать файлы напоминания ${job.id}`,
  );
}

export function reminderWorkspaceAuthorization(job: ClaimedReminder): WorkspaceAuthorization {
  if (job.scope === "group") {
    if (job.groupId === null || job.telegramChatType === null || !GROUP_CHAT_TYPES.has(job.telegramChatType)) {
      invalidContext(job);
    }
    return {
      familyId: job.familyId,
      groupId: job.groupId,
      groupType: "external",
      role: "external",
      telegramChatType: job.telegramChatType as WorkspaceAuthorization["telegramChatType"],
      userId: null,
    };
  }
  if (job.authorUserId === null || job.authorRole === null) invalidContext(job);
  if (job.scope === "personal") {
    return {
      familyId: job.familyId,
      groupId: null,
      groupType: null,
      role: job.authorRole,
      telegramChatType: "private",
      userId: job.authorUserId,
    };
  }
  if (job.groupId === null || job.telegramChatType === null || !GROUP_CHAT_TYPES.has(job.telegramChatType)) {
    invalidContext(job);
  }
  return {
    familyId: job.familyId,
    groupId: job.groupId,
    groupType: "family_private",
    role: job.authorRole,
    telegramChatType: job.telegramChatType as WorkspaceAuthorization["telegramChatType"],
    userId: job.authorUserId,
  };
}

export async function prepareReminderFiles(job: ClaimedReminder, markdown: string): Promise<PreparedTelegramAnswer> {
  let prepared: PreparedTelegramAnswer;
  try {
    prepared = await prepareAnswerFiles({
      auth: () => reminderWorkspaceAuthorization(job),
      markdown,
      resolver: answerFileResolver,
      turnId: `reminder:${job.id}`,
    });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_REMINDER_FILES_READ_FAILED",
      error: error instanceof Error ? error.message : String(error),
      errorCode: isAppError(error) ? error.code : null,
      reminderId: job.id,
    }));
    return unreadAnswerFiles(markdown);
  }
  if (prepared.problems.length > 0) {
    // Checked when the reminder was written; the person now sees a line in place of each.
    console.error(JSON.stringify({
      code: "AGENT_REMINDER_FILES_NOT_ATTACHED",
      problems: prepared.problems.map((problem) => problem.code),
      reminderId: job.id,
    }));
  }
  return prepared;
}
