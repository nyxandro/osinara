/**
 * Application-owned Telegram messages and checks of a group's connection (#465).
 *
 * Exports:
 * - `groupDisconnectedNotice`, `groupReconnectedNotice`, `groupRemovedNotice`, `botRemovedNotice`,
 *   `botRejoinedNotice`: the owner's texts, fixed by the application so every warning arrives whole.
 * - `GroupConnectionTelegram`: what the connection changes need from Telegram.
 * - `groupConnectionTelegram`: sends to the owner's private chat; asks whether the bot is in a group.
 *
 * The owner's confirmations come from the application, not from the model: the warning that data stops
 * updating and can be deleted for good is a promise, and a small model may shorten or retell it.
 */
import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { callTelegramApi } from "../../runtime/telegram/api.js";
import { AppError } from "../app-error.js";

// Statuses of a bot that is in the chat; `left` and `kicked` mean it is not.
const MEMBER_STATUSES = new Set(["administrator", "creator", "member", "restricted"]);
// Telegram answers a question about a chat the bot is no longer in with a refusal, not a status.
const NOT_MEMBER_HTTP_STATUSES = new Set([400, 403]);

export function groupDisconnectedNotice(title: string): string {
  return [
    `⏸ Группа «${title}» отключена. Я больше не читаю и не отвечаю там, напоминания и сценарии группы остановлены.`,
    "Данные группы — история, память, файлы и настройки — сохранены, но с этого момента не обновляются: то, что напишут в группе, пока она отключена, не сохранится. Когда подключите группу снова, запись возобновится с момента подключения.",
    "Если группа больше не понадобится, попросите меня удалить её данные целиком — это навсегда, без возможности восстановления, и освободит место.",
  ].join("\n\n");
}

export function groupReconnectedNotice(title: string): string {
  return `▶️ Группа «${title}» снова подключена. Читаю и отвечаю по прежним правилам, напоминания и сценарии работают, запись сообщений возобновлена с этого момента. Сообщения, написанные, пока группа была отключена, не сохранены.`;
}

export function groupRemovedNotice(title: string): string {
  return `🗑 Данные группы «${title}» удалены навсегда: история, память, файлы, напоминания, сценарии и служебные копии сообщений. Восстановить их нельзя. Я остаюсь в чате, но ничего из него не сохраняю.`;
}

export function botRemovedNotice(title: string): string {
  return `Меня удалили из группы «${title}», и я отключился от неё: не читаю, не отвечаю, напоминания и сценарии группы стоят. История, память и файлы сохранены. Если добавите меня обратно — попросите подключить группу, и всё продолжится.`;
}

export function botRejoinedNotice(title: string): string {
  return `Меня снова добавили в группу «${title}». Пока я её не слушаю. Чтобы подключить с прежними историей и памятью, попросите меня подключить группу.`;
}

export interface GroupConnectionTelegram {
  /** Whether the bot is a member of the group now; throws when Telegram cannot say. */
  botIsMember(telegramChatId: string): Promise<boolean>;
  sendToOwner(ownerTelegramChatId: string, text: string): Promise<void>;
}

async function call(method: string, body: Record<string, number | string>) {
  return await callTelegramApi({
    body,
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS) }),
    method,
  });
}

function membershipCheckFailed(cause: unknown): AppError {
  return new AppError(
    "AGENT_GROUP_MEMBERSHIP_CHECK_FAILED",
    "Не удалось проверить, есть ли я в группе. Попробуйте позже",
    { cause },
  );
}

function resultField(body: unknown, field: string): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  const result = (body as { result?: unknown }).result;
  return typeof result === "object" && result !== null ? (result as Record<string, unknown>)[field] : undefined;
}

export const groupConnectionTelegram: GroupConnectionTelegram = {
  async botIsMember(telegramChatId) {
    let me: Awaited<ReturnType<typeof call>>;
    let member: Awaited<ReturnType<typeof call>>;
    try {
      me = await call("getMe", {});
      const botId = resultField(me.body, "id");
      if (!me.ok || typeof botId !== "number") throw new Error(`getMe answered HTTP ${me.status}`);
      member = await call("getChatMember", { chat_id: telegramChatId, user_id: botId });
    } catch (error) {
      throw membershipCheckFailed(error);
    }
    if (!member.ok) {
      if (NOT_MEMBER_HTTP_STATUSES.has(member.status)) return false;
      throw membershipCheckFailed(new Error(`getChatMember answered HTTP ${member.status}`));
    }
    const status = resultField(member.body, "status");
    if (typeof status !== "string") throw membershipCheckFailed(new Error("getChatMember returned no status"));
    if (status === "restricted") return resultField(member.body, "is_member") === true;
    return MEMBER_STATUSES.has(status);
  },

  async sendToOwner(ownerTelegramChatId, text) {
    const response = await call("sendMessage", { chat_id: ownerTelegramChatId, text });
    if (!response.ok) {
      throw new Error(`AGENT_GROUP_CONNECTION_NOTICE_REJECTED: Telegram rejected sendMessage with HTTP ${response.status}`);
    }
  },
};
