/**
 * Messages of the reminder ↔ Google Calendar mirror to the person.
 *
 * Exports:
 * - `createCalendarMirrorNotices`: sends a notice to the profile's chats and records it.
 * - `productionCalendarMirrorNotices`: the same over Telegram and PostgreSQL.
 * - `NoticeDependencies`, `NoticeRecipient`.
 *
 * A personal profile is told in its owner's private chat, the family profile in every family group.
 * Each message is recorded as a proactive delivery so the model sees it in the chat's history and
 * understands a reply such as «верни». A deleted calendar is offered back with one button pressed
 * by the profile's owner; the press reaches the model as the person's message. Delivery is a
 * boundary: a failure is logged once and not retried, because the stop it reports is visible in
 * the connection status anyway and a second attempt might repeat a delivered message.
 */
import { callTelegramApi } from "../../runtime/telegram/api.js";
import type { JsonObject } from "../../runtime/json.js";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { proactiveDeliveryRepository } from "../proactive-deliveries/proactive-delivery-repository.js";
import { newReplyButtonToken, type ReplyButtonRows } from "../reply-buttons/reply-button-contract.js";
import { replyButtonMarkup } from "../reply-buttons/reply-button-markup.js";
import { replyButtonRepository } from "../reply-buttons/reply-button-repository.js";
import { telegramRichMessageRequest } from "../telegram-rich-messages.js";
import type { CalendarMirrorProfile } from "./calendar-mirror-contract.js";
import { calendarMirrorCalendarName } from "./calendar-mirror-config.js";
import type { CalendarMirrorNotice, MirrorNotices, UnsupportedEditReason } from "./calendar-mirror-cycle-context.js";
import { calendarMirrorRepository } from "./calendar-mirror-repository.js";

const RESTORE_BUTTON_TEXT = "Вернуть календарь";
const RESTORE_BUTTONS: ReplyButtonRows = [[{ text: RESTORE_BUTTON_TEXT }]];
const DELIVERY_TITLE = "Google Календарь";
const TELEGRAM_BAD_REQUEST_STATUS = 400;
const EDIT_REASONS: Readonly<Record<UnsupportedEditReason, string>> = {
  all_day: "у напоминания должно быть время, а не весь день",
  instance: "одно повторение из серии я пока менять не умею",
  past: "это время уже прошло",
  recurrence: "такой повтор я пока не умею: только каждый день, неделю, месяц или год",
};

export interface NoticeRecipient {
  addresseeTelegramUserId: string;
  chatId: string;
  /** Unknown for a group the bot has not seen typed yet: the restore button then cannot be offered. */
  chatType: "group" | "private" | "supergroup" | null;
  groupId: string | null;
  ownerUserId: string | null;
}

interface TelegramAnswer {
  body: unknown;
  ok: boolean;
  status: number;
}

export interface NoticeDependencies {
  buttons: {
    activate(id: string, messageId: string): Promise<void>;
    discard(id: string): Promise<void>;
    stage(input: {
      addresseeTelegramUserId: string;
      buttons: ReplyButtonRows;
      messageText: string;
      telegramChatId: string;
      telegramChatType: Exclude<NoticeRecipient["chatType"], null>;
    }): Promise<{ id: string; markdown: string }>;
  };
  recipients(profile: CalendarMirrorProfile): Promise<NoticeRecipient[]>;
  recordDelivery(delivery: Parameters<typeof proactiveDeliveryRepository.record>[0]): Promise<void>;
  send(method: "sendMessage" | "sendRichMessage", body: JsonObject): Promise<TelegramAnswer>;
}

export function noticeText(profile: CalendarMirrorProfile, notice: CalendarMirrorNotice): string {
  const family = profile.scope === "family";
  const calendar = `«${calendarMirrorCalendarName(profile.scope)}»`;
  switch (notice.kind) {
    case "access_lost":
      return family
        ? "Не могу вести семейные напоминания в Google Календаре: доступ к семейному Google истёк или был отозван. Напоминания в Telegram приходят как обычно. Владелец семьи может подключить Google заново в этой группе. Код: AGENT_CALENDAR_MIRROR_ACCESS_LOST"
        : "Не могу вести напоминания в Google Календаре: доступ к Google истёк или был отозван. Напоминания в Telegram приходят как обычно. Чтобы вернуть календарь, напишите «подключи Google». Код: AGENT_CALENDAR_MIRROR_ACCESS_LOST";
    case "calendar_deleted":
      return `Календарь ${calendar} удалён в Google, и я больше его не веду. Напоминания в Telegram приходят как обычно. ` +
        (family
          ? `Если удалили случайно, владелец семьи может нажать «${RESTORE_BUTTON_TEXT}» или написать мне «верни календарь».`
          : `Если удалили случайно — нажмите «${RESTORE_BUTTON_TEXT}» или напишите мне «верни календарь».`) +
        " Код: AGENT_CALENDAR_MIRROR_CALENDAR_DELETED";
    case "calendar_refused":
      return `Google не дал создать календарь ${calendar}, поэтому напоминаний в Google Календаре не будет. Напоминания в Telegram приходят как обычно. Код: AGENT_CALENDAR_MIRROR_CALENDAR_REFUSED`;
    case "edit_unsupported":
      return `В календаре вы изменили «${notice.title}», но ${EDIT_REASONS[notice.reason]}. Вернул как было. Напишите мне, что поменять, — сделаю. Код: AGENT_CALENDAR_EDIT_UNSUPPORTED`;
    case "event_unsupported":
      return `Событие «${notice.title}» в календаре ${calendar} повторяется так, как я пока не умею, поэтому напоминание по нему не поставил. Простые повторы — каждый день, неделю, месяц или год. Код: AGENT_CALENDAR_EVENT_UNSUPPORTED`;
    case "settings_missing":
      return family
        ? "Чтобы присылать семейные напоминания из календаря, владельцу семьи нужно указать свой часовой пояс в личном чате со мной. Код: AGENT_NOTIFICATION_SETTINGS_REQUIRED"
        : "Чтобы присылать напоминания из календаря, мне нужен ваш часовой пояс. Напишите мне, например: «мой часовой пояс — Москва». Код: AGENT_NOTIFICATION_SETTINGS_REQUIRED";
  }
}

function messageIdOf(answer: TelegramAnswer): string | null {
  const result = (answer.body as { result?: { message_id?: unknown } } | null)?.result;
  return typeof result?.message_id === "number" ? String(result.message_id) : null;
}

async function deliver(
  dependencies: NoticeDependencies,
  recipient: NoticeRecipient,
  text: string,
  offerRestore: boolean,
): Promise<string> {
  const plain = async () => await dependencies.send("sendMessage", { chat_id: recipient.chatId, text });
  let answer: TelegramAnswer;
  if (offerRestore && recipient.chatType === null) {
    console.error(JSON.stringify({ code: "AGENT_CALENDAR_MIRROR_NOTICE_BUTTON_UNAVAILABLE", groupId: recipient.groupId }));
  }
  if (offerRestore && recipient.chatType !== null) {
    const staged = await dependencies.buttons.stage({
      addresseeTelegramUserId: recipient.addresseeTelegramUserId,
      buttons: RESTORE_BUTTONS,
      messageText: text,
      telegramChatId: recipient.chatId,
      telegramChatType: recipient.chatType,
    });
    const rich = telegramRichMessageRequest({ chat_id: recipient.chatId }, staged.markdown, []);
    answer = await dependencies.send("sendRichMessage", (rich as { body: JsonObject }).body);
    if (!answer.ok && answer.status === TELEGRAM_BAD_REQUEST_STATUS) {
      // A refusal delivered nothing: the words still go, without the button.
      await dependencies.buttons.discard(staged.id);
      answer = await plain();
    } else if (answer.ok) {
      const messageId = messageIdOf(answer);
      if (messageId !== null) await dependencies.buttons.activate(staged.id, messageId);
    }
  } else {
    answer = await plain();
  }
  const messageId = answer.ok ? messageIdOf(answer) : null;
  if (messageId === null) throw new Error(`AGENT_CALENDAR_MIRROR_NOTICE_REJECTED: Telegram status ${answer.status}`);
  return messageId;
}

export function createCalendarMirrorNotices(dependencies: NoticeDependencies): MirrorNotices {
  return {
    async send(profile, notice, now) {
      const text = noticeText(profile, notice);
      const recipients = await dependencies.recipients(profile);
      for (const recipient of recipients) {
        try {
          const messageId = await deliver(dependencies, recipient, text, notice.kind === "calendar_deleted");
          await dependencies.recordDelivery({
            content: text,
            deliveredAt: now,
            familyId: profile.familyId,
            groupId: recipient.groupId,
            messageThreadId: null,
            ownerUserId: recipient.ownerUserId,
            scheduledFor: now,
            scope: profile.scope,
            sourceId: profile.workspaceId,
            sourceKind: "calendar_mirror_notice",
            telegramChatId: recipient.chatId,
            telegramMessageId: messageId,
            title: DELIVERY_TITLE,
          });
        } catch (error) {
          console.error(JSON.stringify({
            code: "AGENT_CALENDAR_MIRROR_NOTICE_FAILED",
            error: error instanceof Error ? error.message : String(error),
            notice: notice.kind,
            workspaceId: profile.workspaceId,
          }));
        }
      }
    },
  };
}

function requireBotToken(): string {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error("AGENT_TELEGRAM_CONFIG_MISSING: Не задан токен Telegram для сообщений календаря");
  return botToken;
}

export const productionCalendarMirrorNotices = createCalendarMirrorNotices({
  buttons: {
    async activate(id, messageId) {
      await replyButtonRepository.activate(id, messageId, []);
    },
    async discard(id) {
      await replyButtonRepository.discard(id);
    },
    async stage(input) {
      const set = await replyButtonRepository.stageForReminder({ ...input, reminderId: null, token: newReplyButtonToken() });
      return { id: set.id, markdown: `${input.messageText}\n\n${replyButtonMarkup(set.buttons, set.token)}` };
    },
  },
  recipients: (profile) => calendarMirrorRepository.noticeRecipients(profile),
  recordDelivery: (delivery) => proactiveDeliveryRepository.record(delivery),
  async send(method, body) {
    const signal = AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS);
    return await callTelegramApi({
      body,
      botToken: requireBotToken(),
      fetch: (request, init) => fetch(request, { ...init, signal }),
      method,
    });
  },
});
