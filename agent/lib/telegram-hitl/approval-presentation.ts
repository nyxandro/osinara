/**
 * Semantic Telegram presentation for HITL requests.
 *
 * Exports:
 * - `TelegramApprovalPresenter`: asynchronous trusted approval presentation contract.
 * - `createTelegramApprovalPresenter`: injectable presenter with verified subject resolution.
 * - `presentTelegramApproval`: production presenter backed by PostgreSQL repositories.
 */
import type { SessionContext } from "eve/context";

import { AppError } from "../app-error.js";
import { requirePrivateTelegramOwner } from "../family-context.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { profileProjectionPolicyRepository } from "../profile-projection-policy-repository.js";
import { requireProfileProjectionUpdate } from "../profile-projection-input.js";
import { telegramGroupAdministrationRepository } from "../telegram-group-administration-repository.js";
import { requireManageTelegramGroupInput } from "../tools/manage_telegram_group.js";
import { skillRequiresBash } from "../group-skills/group-skill-catalog.js";
import type { GmailMessageApprovalSubject } from "../google-workspace/gmail-message-approval.js";
import { loadGmailMessageApproval } from "../google-workspace/gmail-message-approval.js";
import { requireGmailMessageInput } from "../google-workspace/gmail-message-contract.js";
import {
  localizeTelegramInputRequest,
  type TelegramInputRequest,
} from "../telegram-interface.js";
import {
  GOOGLE_WORKSPACE_CONSEQUENCE,
  PROFILE_PROJECTION_ENABLE_CONSEQUENCE, PROFILE_PROJECTION_DISABLE_CONSEQUENCE,
  GROUP_SKILLS_BASH_CONSEQUENCE, GROUP_SKILLS_CONSEQUENCE, GROUP_TOOLS_BASH_CONSEQUENCE, GROUP_TOOLS_NO_BASH_CONSEQUENCE,
} from "./approval-consequences.js";
import {
  approvalFact,
  buildApprovalMessage,
  googleWorkspaceFacts,
} from "./approval-message.js";

interface ApprovalPresentationDependencies {
  findProfileProjectionGroup(groupRef: string, ctx: Pick<SessionContext, "session">): Promise<string | null>;
  findGroupTitle(telegramChatId: string, ctx: Pick<SessionContext, "session">): Promise<string | null>;
  findGmailMessage(
    messageId: string,
    profileRef: string,
    ctx: Pick<SessionContext, "session">,
  ): Promise<GmailMessageApprovalSubject>;
}

export type TelegramApprovalPresenter = (
  request: TelegramInputRequest,
  ctx: Pick<SessionContext, "session">,
) => Promise<TelegramInputRequest>;

const GMAIL_MESSAGE_ACTIONS = {
  delete: {
    action: "Безвозвратно удалить письмо Gmail",
    consequence: "Письмо будет удалено навсегда. Его нельзя будет восстановить.",
  },
  mark_read: {
    action: "Отметить письмо Gmail прочитанным",
    consequence: "Письмо больше не будет отмечено как непрочитанное.",
  },
  mark_unread: {
    action: "Отметить письмо Gmail непрочитанным",
    consequence: "Письмо будет отмечено как непрочитанное.",
  },
  restore: {
    action: "Восстановить письмо Gmail из корзины",
    consequence: "Письмо будет возвращено из корзины.",
  },
  trash: {
    action: "Переместить письмо в корзину Gmail",
    consequence: "Письмо будет перемещено в корзину. Его можно будет восстановить.",
  },
} as const;

function approvalValue(value: string | null, missing: string, maxCharacters = 500): string {
  if (value === null) return missing;
  const normalized = value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!normalized) return missing;
  return normalized.length <= maxCharacters
    ? normalized
    : `${normalized.slice(0, maxCharacters - 1).trimEnd()}…`;
}

function gmailMessagePrompt(
  actionName: keyof typeof GMAIL_MESSAGE_ACTIONS,
  message: GmailMessageApprovalSubject,
): string {
  const action = GMAIL_MESSAGE_ACTIONS[actionName];
  return [
    "Подтверждение действия",
    "",
    `Действие: ${action.action}`,
    `Профиль: ${message.scope === "personal" ? "личный" : "семейный"}`,
    `Почтовый ящик: ${approvalValue(message.profileDisplayName, "не определён")}`,
    `Отправитель: ${approvalValue(message.from, "не указан")}`,
    `Тема: ${approvalValue(message.subject, "без темы")}`,
    `Дата: ${approvalValue(message.date, "не указана")}`,
    `Фрагмент письма: ${approvalValue(message.snippet, "не предоставлен Gmail", 240)}`,
    `Gmail ID: ${message.id}`,
    "",
    `Что произойдёт: ${action.consequence}`,
  ].join("\n");
}

function gmailMessageOptions(
  request: TelegramInputRequest,
  actionName: keyof typeof GMAIL_MESSAGE_ACTIONS,
): TelegramInputRequest["options"] {
  const approveLabels: Readonly<Record<keyof typeof GMAIL_MESSAGE_ACTIONS, string>> = {
    delete: "Удалить навсегда",
    mark_read: "Отметить прочитанным",
    mark_unread: "Отметить непрочитанным",
    restore: "Восстановить письмо",
    trash: "Переместить в корзину",
  };
  return request.options?.map((option) => ({
    ...option,
    label: option.id === "approve"
      ? approveLabels[actionName]
      : option.id === "deny" || option.id === "cancel"
        ? "Отменить"
        : option.label,
  }));
}

const GROUP_MESSAGE_MODES = {
  owner_only: "Запуск только по обращению владельца; контекст всех сообщений (owner_only)",
  addressed_only: "Запуск по обращению любого участника; контекст всех сообщений (addressed_only)",
  all: "Запуск по обращению любого участника; контекст всех сообщений (all)",
};

export function createTelegramApprovalPresenter(
  dependencies: ApprovalPresentationDependencies,
): TelegramApprovalPresenter {
  return async (request, ctx) => {
    const localized = localizeTelegramInputRequest(request);
    if (request.display === "confirmation" && request.action.toolName === "manage_profile_projection") {
      const input = requireProfileProjectionUpdate(request.action.input);
      const label = await dependencies.findProfileProjectionGroup(input.groupRef, ctx);
      if (label === null || !label.trim()) throw new AppError("AGENT_PROFILE_PROJECTION_GROUP_NOT_FOUND",
        "Внешняя группа не найдена в вашей семье. Обновите список групп и повторите запрос");
      return {
        ...localized,
        prompt: buildApprovalMessage({
          actionLabel: input.enabled ? "включение переноса фактов в личные профили" : "отключение переноса фактов в личные профили",
          facts: [
            ...approvalFact("Группа", label),
            "Направление: из внешней группы в личные чаты с ботом.",
            "Для кого: каждый участник, связанный с семейной учётной записью, получает только сведения о себе.",
            "Какие данные: подходящие факты об участнике, включая ранее сохранённые в этой группе.",
            "Приватность: Личная и семейная память группе не раскрывается.",
          ],
          consequence: input.enabled ? PROFILE_PROJECTION_ENABLE_CONSEQUENCE : PROFILE_PROJECTION_DISABLE_CONSEQUENCE,
        }),
        options: localized.options?.map(option => ({ ...option,
          label: option.id === "approve" ? (input.enabled ? "Включить перенос" : "Отключить перенос") : option.label,
        })),
      };
    }
    if (request.display === "confirmation" && request.action.toolName === "manage_telegram_group") {
      const parsed = requireManageTelegramGroupInput(request.action.input);
      if (parsed.action === "update_skills" || parsed.action === "update_policy") {
        const chatId = parsed.action === "update_skills" ? parsed.telegramChatId : parsed.policy.telegramChatId;
        const title = await dependencies.findGroupTitle(chatId, ctx);
        if (title === null || !title.trim()) {
          throw new AppError("AGENT_APPROVAL_GROUP_NOT_FOUND", "Группа не найдена в вашей семье. Обновите список групп и повторите запрос");
        }
        const group = `${title} (${chatId})`;
        if (parsed.action === "update_skills") return {
          ...localized,
          prompt: buildApprovalMessage({
            actionLabel: "изменение скиллов группы",
            facts: [...approvalFact("Группа", group), ...approvalFact("Скиллы", parsed.skillAllowlist.join(", ") || "нет")],
            consequence: parsed.skillAllowlist.some(skillRequiresBash) ? GROUP_SKILLS_BASH_CONSEQUENCE : GROUP_SKILLS_CONSEQUENCE,
          }),
        };
        return {
          ...localized,
          prompt: buildApprovalMessage({
            actionLabel: "изменение прав группы",
            facts: [
              ...approvalFact("Группа", group),
              ...approvalFact("Режим сообщений", GROUP_MESSAGE_MODES[parsed.policy.messageMode]),
              ...approvalFact("Инструменты", parsed.policy.toolAllowlist.join(", ") || "только базовые"),
            ],
            consequence: parsed.policy.toolAllowlist.includes("bash") ? GROUP_TOOLS_BASH_CONSEQUENCE : GROUP_TOOLS_NO_BASH_CONSEQUENCE,
          }),
        };
      }
    }
    if (
      request.display === "confirmation" &&
      request.action.toolName === "manage_gmail_message"
    ) {
      const input = requireGmailMessageInput(request.action.input);
      const message = await dependencies.findGmailMessage(input.messageId, input.profileRef, ctx);
      return {
        ...localized,
        options: gmailMessageOptions(localized, input.action),
        prompt: gmailMessagePrompt(input.action, message),
      };
    }
    if (
      request.display === "confirmation" &&
      request.action.toolName === "execute_google_workspace"
    ) {
      return {
        ...localized,
        prompt: buildApprovalMessage({
          actionLabel: "изменение в Google Workspace",
          consequence: GOOGLE_WORKSPACE_CONSEQUENCE,
          facts: googleWorkspaceFacts(request.action.input),
        }),
      };
    }
    return localized;
  };
}

export const presentTelegramApproval = createTelegramApprovalPresenter({
  async findProfileProjectionGroup(groupRef, ctx) {
    requirePrivateTelegramOwner(ctx);
    const policies = await profileProjectionPolicyRepository.list(requireMemoryAuthorization(ctx));
    return policies.find(policy => policy.groupRef === groupRef)?.label ?? null;
  },
  async findGroupTitle(telegramChatId, ctx) {
    const owner = requirePrivateTelegramOwner(ctx);
    const groups = await telegramGroupAdministrationRepository.listStatuses({
      familyId: owner.familyId,
      requestedBy: owner.userId,
    });
    return groups.find((group) => group.telegramChatId === telegramChatId)?.title ?? null;
  },
  findGmailMessage: loadGmailMessageApproval,
});
