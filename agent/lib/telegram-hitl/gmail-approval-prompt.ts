/**
 * Telegram approval card for a Gmail message state change.
 *
 * Exports:
 * - `gmailApprovalPrompt`: detailed card for one message, sender-grouped list for a batch.
 * - `gmailApprovalOptions`: decision buttons naming the action and, for a batch, its size.
 *
 * Key constructs:
 * - Every shown value comes from the verified mailbox read, never from the model, and is flattened
 *   so an untrusted header cannot add a line that looks like part of the card.
 * - A batch is grouped by sender address rather than display name: the name is sender-controlled.
 *   Every group line starts with a backend label, and the real address is never shortened away.
 * - A batch card is shortened step by step until it fits one Telegram prompt part, so the buttons
 *   arrive with the whole list and the settled card keeps it intact.
 */
import { AppError } from "../app-error.js";
import type { GmailMessageAction } from "../google-workspace/gmail-message-contract.js";
import type {
  GmailMessagesApprovalSubject,
  GmailMessageSummary,
} from "../google-workspace/gmail-message-approval.js";
import type { TelegramInputRequest } from "../telegram-interface.js";
import { HITL_PROMPT_CHUNK_CHARACTERS } from "./approval-message.js";

interface BatchLineLimits {
  /** Display name length; 0 shows the address alone. */
  name: number;
  subject: number;
}

// From the most readable to the most compact; the first layout that fits one prompt part wins.
const BATCH_LINE_LIMITS: readonly BatchLineLimits[] = [
  { name: 40, subject: 80 },
  { name: 24, subject: 60 },
  { name: 0, subject: 45 },
  { name: 0, subject: 32 },
  { name: 0, subject: 20 },
];
// A From header without an address has nothing longer to show, so it keeps a readable minimum.
const SENDER_WITHOUT_ADDRESS_MIN_CHARACTERS = 24;

const SINGLE_ACTIONS: Readonly<Record<GmailMessageAction, { action: string; approve: string; consequence: string }>> = {
  delete: {
    action: "Безвозвратно удалить письмо Gmail",
    approve: "Удалить навсегда",
    consequence: "Письмо будет удалено навсегда. Его нельзя будет восстановить.",
  },
  mark_read: {
    action: "Отметить письмо Gmail прочитанным",
    approve: "Отметить прочитанным",
    consequence: "Письмо больше не будет отмечено как непрочитанное.",
  },
  mark_unread: {
    action: "Отметить письмо Gmail непрочитанным",
    approve: "Отметить непрочитанным",
    consequence: "Письмо будет отмечено как непрочитанное.",
  },
  restore: {
    action: "Восстановить письмо Gmail из корзины",
    approve: "Восстановить письмо",
    consequence: "Письмо будет возвращено из корзины.",
  },
  trash: {
    action: "Переместить письмо в корзину Gmail",
    approve: "Переместить в корзину",
    consequence: "Письмо будет перемещено в корзину. Его можно будет восстановить.",
  },
};

const BATCH_ACTIONS: Readonly<Record<GmailMessageAction, { action: string; approve: string; consequence: string }>> = {
  delete: {
    action: "Безвозвратно удалить письма Gmail",
    approve: "Удалить навсегда",
    consequence: "Письма будут удалены навсегда. Их нельзя будет восстановить.",
  },
  mark_read: {
    action: "Отметить письма Gmail прочитанными",
    approve: "Отметить прочитанными",
    consequence: "Письма больше не будут отмечены как непрочитанные.",
  },
  mark_unread: {
    action: "Отметить письма Gmail непрочитанными",
    approve: "Отметить непрочитанными",
    consequence: "Письма будут отмечены как непрочитанные.",
  },
  restore: {
    action: "Восстановить письма Gmail из корзины",
    approve: "Восстановить",
    consequence: "Письма будут возвращены из корзины.",
  },
  trash: {
    action: "Переместить письма в корзину Gmail",
    approve: "Переместить в корзину",
    consequence: "Письма будут перемещены в корзину. Их можно будет восстановить.",
  },
};

const MONTHS: Readonly<Record<string, string>> = {
  apr: "04", aug: "08", dec: "12", feb: "02", jan: "01", jul: "07",
  jun: "06", mar: "03", may: "05", nov: "11", oct: "10", sep: "09",
};

function approvalValue(value: string | null, missing: string, maxCharacters = 500): string {
  if (value === null) return missing;
  const normalized = value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!normalized) return missing;
  return normalized.length <= maxCharacters
    ? normalized
    : `${normalized.slice(0, maxCharacters - 1).trimEnd()}…`;
}

function lettersCount(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${count} писем`;
  if (last === 1) return `${count} письмо`;
  if (last >= 2 && last <= 4) return `${count} письма`;
  return `${count} писем`;
}

/** Calendar date as written in the Date header itself; the header's own offset decides the day. */
function shortDate(value: string | null): string | null {
  const match = value?.match(/\b(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})\b/u);
  const month = match ? MONTHS[match[2]!.toLowerCase()] : undefined;
  if (!match || !month) return null;
  return `${match[1]!.padStart(2, "0")}.${month}.${match[3]}`;
}

interface Sender {
  address: string | null;
  /** Display name, or the whole header when it has no address. */
  name: string;
}

/** The last angle-bracket address is the real mailbox; a display name may quote a fake one. */
function parseSender(from: string | null): Sender | null {
  if (from === null) return null;
  const flat = approvalValue(from, "");
  if (!flat) return null;
  const bracketed = [...flat.matchAll(/<([^<>\s]+@[^<>\s]+)>/gu)].at(-1);
  if (bracketed) {
    const name = flat.slice(0, bracketed.index).trim().replace(/^"(.*)"$/u, "$1").trim();
    return { address: bracketed[1]!, name };
  }
  if (/^[^\s<>]+@[^\s<>]+$/u.test(flat)) return { address: flat, name: "" };
  return { address: null, name: flat };
}

function senderKey(from: string | null): string {
  const sender = parseSender(from);
  return (sender?.address ?? sender?.name ?? "").toLowerCase();
}

function senderLabel(from: string | null, limits: BatchLineLimits): string | null {
  const sender = parseSender(from);
  if (sender === null) return null;
  if (sender.address === null) {
    return approvalValue(sender.name, "", Math.max(limits.name, SENDER_WITHOUT_ADDRESS_MIN_CHARACTERS));
  }
  const name = limits.name > 0 ? approvalValue(sender.name, "", limits.name) : "";
  return name ? `${name} <${sender.address}>` : sender.address;
}

function subjectLine(message: GmailMessageSummary, limits: BatchLineLimits, withSender: boolean): string {
  const subject = approvalValue(message.subject, "без темы", limits.subject);
  const sender = withSender ? `${senderLabel(message.from, limits) ?? "Отправитель не указан"} — ` : "";
  const date = shortDate(message.date);
  return `• ${sender}${subject}${date ? ` · ${date}` : ""}`;
}

function groupBySender(messages: readonly GmailMessageSummary[]): {
  repeated: GmailMessageSummary[][];
  singles: GmailMessageSummary[];
} {
  const groups = new Map<string, GmailMessageSummary[]>();
  for (const message of messages) {
    const key = senderKey(message.from);
    groups.set(key, [...(groups.get(key) ?? []), message]);
  }
  // Array.prototype.sort is stable, so equally large groups keep the order Gmail listed them in.
  return {
    repeated: [...groups.values()].filter((group) => group.length > 1)
      .sort((left, right) => right.length - left.length),
    singles: [...groups.values()].filter((group) => group.length === 1).map((group) => group[0]!),
  };
}

function batchSections(
  grouped: ReturnType<typeof groupBySender>,
  limits: BatchLineLimits,
): string[] {
  const sections = grouped.repeated.map((group) => [
    `Отправитель: ${senderLabel(group[0]!.from, limits) ?? "не указан"} — ${lettersCount(group.length)}`,
    ...group.map((message) => subjectLine(message, limits, false)),
  ].join("\n"));
  if (grouped.singles.length > 0) {
    const lines = grouped.singles.map((message) => subjectLine(message, limits, true));
    sections.push((grouped.repeated.length > 0
      ? [`Другие отправители — ${lettersCount(grouped.singles.length)}`, ...lines]
      : lines).join("\n"));
  }
  return sections;
}

function requireRequestedMessages(
  messageIds: readonly string[],
  subject: GmailMessagesApprovalSubject,
): readonly GmailMessageSummary[] {
  // The card must describe exactly the batch that executes: same IDs, same count, same order.
  const shown = subject.messages.map((message) => message.id);
  if (shown.length !== messageIds.length || shown.some((id, index) => id !== messageIds[index])) {
    throw new AppError(
      "AGENT_GMAIL_APPROVAL_SUBJECT_MISMATCH",
      "Gmail вернул сведения не о тех письмах. Действие остановлено",
    );
  }
  return subject.messages;
}

export function gmailApprovalPrompt(
  actionName: GmailMessageAction,
  messageIds: readonly string[],
  subject: GmailMessagesApprovalSubject,
): string {
  const messages = requireRequestedMessages(messageIds, subject);
  const mailbox = [
    `Профиль: ${subject.scope === "personal" ? "личный" : "семейный"}`,
    `Почтовый ящик: ${approvalValue(subject.profileDisplayName, "не определён")}`,
  ];
  if (messages.length === 1) {
    const message = messages[0]!;
    const action = SINGLE_ACTIONS[actionName];
    return [
      "Подтверждение действия",
      "",
      `Действие: ${action.action}`,
      ...mailbox,
      `Отправитель: ${approvalValue(message.from, "не указан")}`,
      `Тема: ${approvalValue(message.subject, "без темы")}`,
      `Дата: ${approvalValue(message.date, "не указана")}`,
      `Фрагмент письма: ${approvalValue(message.snippet, "не предоставлен Gmail", 240)}`,
      `Gmail ID: ${message.id}`,
      "",
      `Что произойдёт: ${action.consequence}`,
    ].join("\n");
  }
  const action = BATCH_ACTIONS[actionName];
  const grouped = groupBySender(messages);
  const render = (limits: BatchLineLimits) => [
    "Подтверждение действия",
    [`Действие: ${action.action}`, `Писем: ${messages.length}`, ...mailbox].join("\n"),
    ...batchSections(grouped, limits),
    `Что произойдёт: ${action.consequence}`,
  ].join("\n\n");
  const layouts = BATCH_LINE_LIMITS.map(render);
  // Extremely long sender addresses can still overflow; delivery then splits the card into parts.
  return layouts.find((card) => card.length <= HITL_PROMPT_CHUNK_CHARACTERS) ?? layouts.at(-1)!;
}

export function gmailApprovalOptions(
  request: TelegramInputRequest,
  actionName: GmailMessageAction,
  count: number,
): TelegramInputRequest["options"] {
  const approve = count === 1
    ? SINGLE_ACTIONS[actionName].approve
    : `${BATCH_ACTIONS[actionName].approve} (${count})`;
  return request.options?.map((option) => ({
    ...option,
    label: option.id === "approve"
      ? approve
      : option.id === "deny" || option.id === "cancel"
        ? "Отменить"
        : option.label,
  }));
}
