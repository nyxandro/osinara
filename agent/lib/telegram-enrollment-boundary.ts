/**
 * Telegram owner bootstrap and invitation deep-link boundary.
 *
 * Exports:
 * - `handleTelegramEnrollmentBoundary`: consumes enrollment-only private messages before the agent.
 *
 * Key constructs:
 * - Bootstrap claims accept only the exact one-time `/start <43-character-code>` command.
 * - Invitation claims and existing-member deep links never become ordinary model turns.
 * - A guest link admits its claimant at once (#471): the guest is welcomed and the inviting owner told.
 */
import type { TelegramContext } from "../runtime/telegram/channel-types.js";
import type { TelegramMessage } from "../runtime/telegram/inbound.js";

import type { GuestInvitationClaim } from "./guests/guest-enrollment.js";

import { telegramProfileName } from "./telegram-on-message-context.js";
import type { TelegramMessageRepositories } from "./telegram-on-message-repositories.js";

const OWNER_BOOTSTRAP_COMMAND_PATTERN = /^\/start ([A-Za-z0-9_-]{43})$/u;

const GUEST_WELCOME: Readonly<Record<GuestInvitationClaim["guest"], string>> = {
  joined: "Готово, вы подключены к агенту как гость. Пишите сюда — я помогу с поиском, файлами, напоминаниями и другими задачами. Ваша память отдельная и не пересекается с памятью других людей.",
  returned: "С возвращением! Доступ к агенту снова открыт: ваша память и файлы на месте, а напоминания и сценарии стоят на паузе — попросите меня их возобновить.",
};

/**
 * One line to the owner about each guest who came in by their link, so a forwarded link that reached the wrong
 * person is noticed. The join is already committed: a failed notice is logged, and the owner still sees the
 * guest in their list.
 */
async function tellOwnerAboutGuest(ctx: TelegramContext, claim: GuestInvitationClaim, message: TelegramMessage): Promise<void> {
  const username = message.from?.username;
  const who = `${telegramProfileName(message)}${username ? ` (@${username})` : ""}`;
  const failed = (error: string) => console.error(JSON.stringify({ code: "AGENT_GUEST_JOIN_OWNER_NOTICE_FAILED", error }));
  try {
    const response = await ctx.telegram.request("sendMessage", {
      chat_id: claim.hostOwnerTelegramUserId,
      text: `Гость подключился по вашей ссылке: ${who}. Посмотреть гостей, выключить им инструменты и скиллы или закрыть доступ можно здесь, в личном чате со мной.`,
    });
    // Telegram answers a refusal (the owner blocked the bot, say) with ok=false rather than a thrown error.
    if (!response.ok) failed(`Telegram refused the notice with status ${response.status}`);
  } catch (error) {
    failed(error instanceof Error ? error.message : String(error));
  }
}

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
      "AGENT_INVITATION_NOT_APPLICABLE: Вы уже подключены к агенту.",
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

  // Bootstrap plaintext is consumed entirely at the channel boundary and never reaches the agent.
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
    if (claim === "former_guest") {
      await input.ctx.telegram.sendMessage(
        "AGENT_INVITATION_FORMER_GUEST: Вы были гостем этого агента, а гостя пока нельзя перевести в семью. Сообщите об этом владельцу.",
      );
      return true;
    }
    if (claim !== "invalid") {
      // The owner's line goes out first and whatever happens to the welcome: it is how a wrong claimant is noticed.
      await tellOwnerAboutGuest(input.ctx, claim, input.message);
      await input.ctx.telegram.sendMessage(GUEST_WELCOME[claim.guest]);
      return true;
    }
  }

  await input.ctx.telegram.sendMessage(
    "AGENT_ACCESS_DENIED: У вас нет доступа. Попросите владельца отправить приглашение.",
  );
  return true;
}
