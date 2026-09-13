/**
 * Telegram owner bootstrap and invitation deep-link boundary.
 *
 * Exports:
 * - `handleTelegramEnrollmentBoundary`: consumes enrollment-only private messages before Eve.
 *
 * Key constructs:
 * - Bootstrap claims accept only the exact one-time `/start <43-character-code>` command.
 * - Invitation claims and existing-member deep links never become ordinary model turns.
 */
import type { TelegramContext, TelegramMessage } from "eve/channels/telegram";

import { telegramProfileName } from "./telegram-on-message-context.js";
import type { TelegramMessageRepositories } from "./telegram-on-message-repositories.js";

const OWNER_BOOTSTRAP_COMMAND_PATTERN = /^\/start ([A-Za-z0-9_-]{43})$/u;

type TelegramIdentity = Awaited<ReturnType<TelegramMessageRepositories["telegram"]["findIdentity"]>>;

export async function handleTelegramEnrollmentBoundary(input: {
  ctx: TelegramContext;
  identity: TelegramIdentity;
  invitationCode: string | null;
  message: TelegramMessage;
  repositories: Pick<TelegramMessageRepositories, "family" | "telegram">;
}): Promise<boolean> {
  // A replay after owner creation must never forward the one-time bootstrap secret to the model.
  if (input.identity && OWNER_BOOTSTRAP_COMMAND_PATTERN.test(input.message.text.trim())) return true;
  // Invitation secrets are channel commands, not conversation content, even for existing members.
  if (input.identity && input.invitationCode) {
    await input.ctx.telegram.sendMessage(
      "AGENT_INVITATION_NOT_APPLICABLE: Вы уже подключены к семейному агенту.",
    );
    return true;
  }
  if (input.identity || input.message.chat.type !== "private") return false;

  const sender = input.message.from;
  if (!sender) {
    throw new Error(
      "AGENT_TELEGRAM_ENROLLMENT_SENDER_MISSING: Telegram не передал отправителя команды подключения",
    );
  }
  const ownerConfigured = await input.repositories.telegram.hasOwner();

  // Bootstrap plaintext is consumed entirely at the channel boundary and never reaches Eve.
  if (!ownerConfigured) {
    const code = input.message.text.trim().match(OWNER_BOOTSTRAP_COMMAND_PATTERN)?.[1];
    if (!code) {
      await input.ctx.telegram.sendMessage(
        "AGENT_BOOTSTRAP_COMMAND_INVALID: Откройте одноразовую ссылку владельца, полученную на сервере.",
      );
      return true;
    }
    const claim = await input.repositories.telegram.claimFirstOwner(code, {
      displayName: telegramProfileName(input.message),
      telegramUserId: sender.id,
      ...(sender.username ? { username: sender.username } : {}),
    });
    if (claim === "claimed") {
      await input.ctx.telegram.sendMessage("Владелец создан. Семейный агент готов к настройке.");
      return true;
    }
    await input.ctx.telegram.sendMessage(
      "AGENT_BOOTSTRAP_CODE_INVALID: Код недействителен или истек. Создайте новый код на сервере.",
    );
    return true;
  }

  // Only a strict Telegram deep-link command can enter the invitation verifier.
  if (input.invitationCode) {
    const claim = await input.repositories.family.claimInvitation(input.invitationCode, {
      displayName: telegramProfileName(input.message),
      telegramUserId: sender.id,
      ...(sender.username ? { username: sender.username } : {}),
    });
    if (claim === "pending") {
      await input.ctx.telegram.sendMessage(
        "AGENT_INVITATION_PENDING: Заявка отправлена владельцу. Доступ появится после подтверждения.",
      );
      return true;
    }
  }

  await input.ctx.telegram.sendMessage(
    "AGENT_ACCESS_DENIED: У вас нет доступа. Попросите владельца отправить приглашение.",
  );
  return true;
}
