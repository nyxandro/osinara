/**
 * Semantic Telegram presentation for HITL requests.
 *
 * Exports:
 * - `TelegramApprovalPresenter`: asynchronous trusted approval presentation contract.
 * - `createTelegramApprovalPresenter`: injectable presenter with verified subject resolution.
 * - `presentTelegramApproval`: production presenter backed by PostgreSQL repositories.
 */
import type { SessionContext } from "../../runtime/context.js";

import { AppError } from "../app-error.js";
import { requirePrivateTelegramOwner } from "../family-context.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { profileProjectionPolicyRepository } from "../profile-projection-policy-repository.js";
import { requireProfileProjectionUpdate } from "../profile-projection-input.js";
import { telegramGroupAdministrationRepository } from "../telegram-group-administration-repository.js";
import { requireManageTelegramGroupInput } from "../tools/manage_telegram_group.js";
import type { GmailMessagesApprovalSubject } from "../google-workspace/gmail-message-approval.js";
import { loadGmailMessageApproval } from "../google-workspace/gmail-message-approval.js";
import { requireGmailMessageInput } from "../google-workspace/gmail-message-contract.js";
import {
  localizeTelegramInputRequest,
  type TelegramInputRequest,
} from "../telegram-interface.js";
import {
  GOOGLE_WORKSPACE_CONSEQUENCE,
  PROFILE_PROJECTION_ENABLE_CONSEQUENCE, PROFILE_PROJECTION_DISABLE_CONSEQUENCE,
  GROUP_TOOLS_BASH_CONSEQUENCE, GROUP_TOOLS_NO_BASH_CONSEQUENCE,
} from "./approval-consequences.js";
import {
  approvalFact,
  buildApprovalMessage,
  googleWorkspaceFacts,
} from "./approval-message.js";
import {
  EXTERNAL_SCHEDULE_ACTION_LABELS,
  externalScheduleFacts,
  type ExternalScheduleTarget,
} from "./external-schedule-approval.js";
import { externalAgentScheduleRepository } from "../agent-schedules/external-agent-schedule-repository.js";
import { gmailApprovalOptions, gmailApprovalPrompt } from "./gmail-approval-prompt.js";

interface ApprovalPresentationDependencies {
  findProfileProjectionGroup(groupRef: string, ctx: Pick<SessionContext, "session">): Promise<string | null>;
  findGroupTitle(telegramChatId: string, ctx: Pick<SessionContext, "session">): Promise<string | null>;
  /** The owner's automation an update targets; fails when it is not one of theirs. */
  findExternalSchedule(
    id: string,
    ctx: Pick<SessionContext, "session">,
  ): Promise<{ title: string; telegramChatId: string; telegramGroupTitle: string }>;
  findGmailMessages(
    messageIds: readonly string[],
    profileRef: string,
    ctx: Pick<SessionContext, "session">,
  ): Promise<GmailMessagesApprovalSubject>;
}

export type TelegramApprovalPresenter = (
  request: TelegramInputRequest,
  ctx: Pick<SessionContext, "session">,
) => Promise<TelegramInputRequest>;

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
      if (parsed.action === "update_policy") {
        const chatId = parsed.policy.telegramChatId;
        const title = await dependencies.findGroupTitle(chatId, ctx);
        if (title === null || !title.trim()) {
          throw new AppError("AGENT_APPROVAL_GROUP_NOT_FOUND", "Группа не найдена в вашей семье. Обновите список групп и повторите запрос");
        }
        const group = `${title} (${chatId})`;
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
    if (request.display === "confirmation" && request.action.toolName === "manage_external_group_schedule") {
      // The approval policy denied any invalid input already, so the action and its target are set.
      const input = request.action.input;
      if (input.action === "create" || input.action === "update") {
        let target: ExternalScheduleTarget;
        if (input.action === "update") {
          const schedule = await dependencies.findExternalSchedule(String(input.id), ctx);
          target = { automationTitle: schedule.title, groupTitle: schedule.telegramGroupTitle, telegramChatId: schedule.telegramChatId };
        } else {
          const telegramChatId = String(input.telegramChatId);
          const title = await dependencies.findGroupTitle(telegramChatId, ctx);
          if (title === null || !title.trim()) {
            throw new AppError("AGENT_APPROVAL_GROUP_NOT_FOUND", "Группа не найдена в вашей семье. Обновите список групп и повторите запрос");
          }
          target = { groupTitle: title, telegramChatId };
        }
        return {
          ...localized,
          prompt: buildApprovalMessage({
            actionLabel: EXTERNAL_SCHEDULE_ACTION_LABELS[input.action]!,
            facts: externalScheduleFacts(input, target),
          }),
        };
      }
    }
    if (
      request.display === "confirmation" &&
      request.action.toolName === "manage_gmail_message"
    ) {
      const input = requireGmailMessageInput(request.action.input);
      const subject = await dependencies.findGmailMessages(input.messageIds, input.profileRef, ctx);
      return {
        ...localized,
        options: gmailApprovalOptions(localized, input.action, input.messageIds.length),
        prompt: gmailApprovalPrompt(input.action, input.messageIds, subject),
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
  async findExternalSchedule(id, ctx) {
    const owner = requirePrivateTelegramOwner(ctx);
    return await externalAgentScheduleRepository.find({ familyId: owner.familyId, requestedBy: owner.userId }, id);
  },
  findGmailMessages: loadGmailMessageApproval,
});
