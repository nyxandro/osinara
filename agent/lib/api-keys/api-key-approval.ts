/**
 * The owner's confirmation card for granting an API key beyond the private chat.
 *
 * Export:
 * - `apiKeyGrantPrompt`: the card text, built from the stored key, the live group title and the guest's
 *   record, not from words the model chose. A guest is named with their @username or Telegram ID (#479);
 *   execution still rechecks the name against the guest's record, like every guest change (#474).
 */
import { AppError } from "../app-error.js";
import { guestApprovalLabel, type GuestApprovalSubject } from "../guests/guest-approval-subject.js";
import { API_KEY_GRANT_CONSEQUENCE } from "../telegram-hitl/approval-consequences.js";
import { approvalFact, buildApprovalMessage } from "../telegram-hitl/approval-message.js";
import type { ApiKeySettings } from "./api-key-repository.js";

export async function apiKeyGrantPrompt(input: {
  readonly findGroupTitle: (telegramChatId: string) => Promise<string | null>;
  readonly findGuest: (guestUserId: string) => Promise<GuestApprovalSubject | null>;
  readonly guestDisplayName: unknown;
  readonly guestUserId: unknown;
  readonly key: (ApiKeySettings & { readonly name: string }) | null;
  readonly target: unknown;
  readonly telegramChatId: unknown;
}): Promise<string> {
  if (input.key === null) {
    throw new AppError("AGENT_API_KEY_NOT_FOUND", "Такого ключа нет. Посмотрите список ключей и повторите с точным именем");
  }
  let recipient = "вся семья: личные чаты членов семьи и семейные группы";
  if (input.target === "guest") {
    const guest = guestApprovalLabel(await input.findGuest(String(input.guestUserId)), input.guestDisplayName);
    recipient = `гость ${guest} — его личный чат и песочница`;
  }
  if (input.target === "group") {
    const telegramChatId = String(input.telegramChatId);
    const title = await input.findGroupTitle(telegramChatId);
    if (title === null || !title.trim()) {
      throw new AppError("AGENT_APPROVAL_GROUP_NOT_FOUND", "Группа не найдена в вашей семье. Обновите список групп и повторите запрос");
    }
    recipient = `внешняя группа «${title}» (${telegramChatId})`;
  }
  return buildApprovalMessage({
    actionLabel: "выдача ключа API",
    consequence: API_KEY_GRANT_CONSEQUENCE,
    facts: [
      ...approvalFact("Ключ", `${input.key.name} — ${input.key.purpose}`),
      ...approvalFact("Сервис", input.key.upstreamBaseUrl),
      ...approvalFact("Кому", recipient),
    ],
  });
}
