/**
 * Shared Telegram authorization-boundary test fixtures.
 *
 * Exports:
 * - `BOT_USERNAME`: stable bot identity used by dispatch tests.
 * - `privateMessage` and `groupMessage`: minimal parsed Eve Telegram messages.
 * - `telegramContext`: Telegram channel context with an observable sender.
 * - `repositories`: isolated application repository doubles for message-handler tests.
 */
import type { TelegramContext, TelegramMessage } from "eve/channels/telegram";
import { vi } from "vitest";

export const BOT_USERNAME = "osinara_bot";

export function privateMessage(text: string): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: "telegram-101", type: "private" },
    from: { firstName: "Анна", id: "telegram-101", isBot: false, username: "anna" },
    messageId: "1",
    raw: { date: 1_700_000_000 },
    text,
  };
}

export function groupMessage(text: string): TelegramMessage {
  return {
    ...privateMessage(text),
    chat: { id: "group-101", title: "Группа", type: "group" },
  };
}

export function telegramContext() {
  const sendMessage = vi.fn().mockResolvedValue({});
  return {
    context: {
      telegram: {
        botUsername: BOT_USERNAME,
        sendMessage,
      },
    } as unknown as TelegramContext,
    sendMessage,
  };
}

export function repositories() {
  return {
    attachments: {
      persist: vi.fn().mockResolvedValue([]),
    },
    family: {
      claimInvitation: vi.fn(),
    },
    hitl: {
      authorizeReply: vi.fn().mockResolvedValue("not_applicable"),
    },
    journal: {
      listBefore: vi.fn().mockResolvedValue([]),
      record: vi.fn().mockResolvedValue("inserted"),
    },
    proactiveDeliveries: {
      listPendingContext: vi.fn().mockResolvedValue(null),
    },
    session: {
      hasRoute: vi.fn().mockResolvedValue(false),
      prepareTurn: vi.fn().mockResolvedValue({
        continuationToken: "telegram-101::",
        generation: 0,
        id: "session-1",
        rotated: false,
        sandboxSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    },
    telegram: {
      claimFirstOwner: vi.fn(),
      findGroup: vi.fn().mockResolvedValue(null),
      findIdentity: vi.fn().mockResolvedValue(null),
      hasOwner: vi.fn(),
    },
  };
}
