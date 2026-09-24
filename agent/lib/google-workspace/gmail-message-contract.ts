/** Structured contract for Gmail message state changes over one bounded batch of exact messages. */
import { z } from "zod";

import { AppError } from "../app-error.js";
import { fitsApprovableGoogleWorkspaceArguments } from "./google-workspace-command-policy.js";

// One approval card must stay readable in Telegram; larger selections are split into further batches.
export const GMAIL_MESSAGE_BATCH_MAX = 30;

function isVisibleIdentifier(value: string): boolean {
  return [...value].every((character) =>
    character.trim() !== "" && !/[\p{Cc}\p{Cf}]/u.test(character)
  );
}

const messageIdSchema = z.string().min(1).max(512).refine(
  isVisibleIdentifier,
  "messageId должен состоять из видимых символов без пробелов",
).refine(
  // The approval metadata read puts the ID into a URL path, where dot segments would change the route.
  (value) => value !== "." && value !== "..",
  "messageId не может быть сегментом пути",
);

const gmailMessageInputObject = z.object({
  action: z.enum(["trash", "delete", "restore", "mark_read", "mark_unread"]).describe(
    "Точное изменение состояния, одинаковое для всех писем пачки",
  ),
  messageIds: z.array(messageIdSchema).min(1).max(GMAIL_MESSAGE_BATCH_MAX).refine(
    (ids) => new Set(ids).size === ids.length,
    "messageIds не должны повторяться",
  ).describe(
    `Точные Gmail message ID из результата чтения или поиска, от 1 до ${GMAIL_MESSAGE_BATCH_MAX} за вызов`,
  ),
  profileRef: z.string().min(1).max(512).refine(
    isVisibleIdentifier,
    "profileRef должен состоять из видимых символов без пробелов",
  ).describe("Точная ссылка на Google-профиль из результата чтения Gmail"),
}).strict();

export type GmailMessageInput = z.infer<typeof gmailMessageInputObject>;
export type GmailMessageAction = GmailMessageInput["action"];

const LABEL_CHANGES: Readonly<Record<
  Exclude<GmailMessageAction, "delete">,
  { addLabelIds?: string[]; removeLabelIds?: string[] }
>> = {
  // Gmail documents TRASH and UNREAD as manually applicable system labels, so one batchModify
  // request changes the whole batch instead of one provider call per message.
  mark_read: { removeLabelIds: ["UNREAD"] },
  mark_unread: { addLabelIds: ["UNREAD"] },
  restore: { removeLabelIds: ["TRASH"] },
  trash: { addLabelIds: ["TRASH"] },
};

export function gmailMessageMutationArgv(
  input: Pick<GmailMessageInput, "action" | "messageIds">,
): string[] {
  const route = ["gmail", "users", "messages", input.action === "delete" ? "batchDelete" : "batchModify"];
  const body = input.action === "delete"
    ? { ids: input.messageIds }
    : { ids: input.messageIds, ...LABEL_CHANGES[input.action] };
  return [...route, "--params", JSON.stringify({ userId: "me" }), "--json", JSON.stringify(body)];
}

// The executor re-applies the approvable-size policy after the prompt; checking it here keeps an
// oversized batch from reaching the person as a card that can never execute.
export const gmailMessageInputSchema = gmailMessageInputObject.refine(
  (input) => fitsApprovableGoogleWorkspaceArguments(gmailMessageMutationArgv(input)),
  { message: "Слишком длинные messageId для одной пачки. Разделите письма на несколько вызовов", path: ["messageIds"] },
);

export function requireGmailMessageInput(input: unknown): GmailMessageInput {
  const parsed = gmailMessageInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      "AGENT_GMAIL_MESSAGE_INPUT_INVALID",
      `Не удалось определить письма, профиль или действие Gmail. Передайте от 1 до ${GMAIL_MESSAGE_BATCH_MAX} разных messageId и точный profileRef`,
    );
  }
  return parsed.data;
}
