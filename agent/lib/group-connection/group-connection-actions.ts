/**
 * The owner's disconnection and reconnection of an external group, end to end (#465).
 *
 * Exports:
 * - `GroupConnectionActionDependencies`: state, Telegram, key publication, sandboxes.
 * - `createGroupConnectionActions`: `disconnect`, `reconnect` and `remove`, each returning the model's
 *   result.
 * - `groupConnectionActions`: the production actions.
 *
 * Key constructs:
 * - The state changes in one transaction; keys, sandboxes and the owner's confirmation follow it. A
 *   failure there is logged and never undoes the change: the group stays as the owner asked.
 * - The confirmation comes from the application; the model is told not to repeat it, or, when it could
 *   not be sent, to pass its substance on itself.
 * - Reconnection first asks Telegram whether the bot is still in the group: a group the bot was removed
 *   from would only collect delivery errors.
 * - Removal deletes the raw copies of the chat's messages too (#464): once before the registration
 *   goes, so the transaction stays small, and once after, for what arrived meanwhile. The group's
 *   sandboxes stop after the commit, never inside it.
 */
import { EMPTY_DELIVERY_MARKER } from "../../runtime/turn/step-history.js";
import { apiKeyPublisher } from "../api-keys/api-key-projection.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { telegramGroupAdministrationRepository } from "../telegram-group-administration-repository.js";
import { stopGroupSandboxes, stopSandboxThreads } from "../telegram-group-policy-repository.js";
import { purgeChatIngressCopies } from "./group-ingress-purge.js";
import { groupConnectionRepository } from "./group-connection-repository.js";
import {
  groupConnectionTelegram,
  groupDisconnectedNotice,
  groupReconnectedNotice,
  groupRemovedNotice,
  type GroupConnectionTelegram,
} from "./group-connection-telegram.js";

export interface GroupConnectionActionDependencies {
  publishApiKeys(): Promise<void>;
  purgeIngressCopies(telegramChatId: string): Promise<number>;
  removeRegistration: typeof telegramGroupAdministrationRepository.removeRegistration;
  stopSandboxThreads(threadIds: readonly string[]): Promise<void>;
  repository: Pick<typeof groupConnectionRepository, "disconnect" | "find" | "reconnect">;
  stopSandboxes(groupId: string): Promise<void>;
  telegram: GroupConnectionTelegram;
}

interface OwnerRequest {
  familyId: string;
  ownerTelegramChatId: string;
  requestedBy: string;
  telegramChatId: string;
}

const CONFIRMATION_SENT_STEP =
  "The application has sent the owner its confirmation of this change, with every warning they need. " +
  `If this was all they asked, end the turn with exactly the line ${EMPTY_DELIVERY_MARKER}; otherwise answer only the rest. Do not repeat the confirmation.`;
const DISCONNECTED_UNSENT_STEP =
  "The application could not send its confirmation. Tell the owner yourself: the group is disconnected; you neither read nor answer there and its reminders and schedules are stopped; its history, memory, files and settings are kept but are no longer updated from now on, and recording resumes from the moment it is reconnected; if the group is no longer needed, its data can be deleted for good on request.";
const REMOVED_UNSENT_STEP =
  "The application could not send its confirmation. Tell the owner yourself: the group's history, memory, files, reminders, schedules and the service copies of its messages were deleted for good and cannot be restored; you stay in the chat but keep nothing from it.";
const RECONNECTED_UNSENT_STEP =
  "The application could not send its confirmation. Tell the owner yourself: the group is connected again under its previous rules, recording resumed from now on, and what was written there while it was disconnected was not kept.";

function logged(code: string, error: unknown, groupId: string): void {
  console.error(JSON.stringify({ code, error: error instanceof Error ? error.message : String(error), groupId }));
}

export function createGroupConnectionActions(dependencies: GroupConnectionActionDependencies) {
  // After the commit: the change stands even when one of these fails.
  const afterChange = async (groupId: string, stopSandboxes: boolean): Promise<void> => {
    try {
      await dependencies.publishApiKeys();
    } catch (error) {
      logged("AGENT_API_KEY_PUBLISH_FAILED", error, groupId);
    }
    if (!stopSandboxes) return;
    try {
      await dependencies.stopSandboxes(groupId);
    } catch (error) {
      logged("AGENT_GROUP_SANDBOX_STOP_FAILED", error, groupId);
    }
  };

  const confirm = async (ownerTelegramChatId: string, text: string, groupId: string): Promise<boolean> => {
    try {
      await dependencies.telegram.sendToOwner(ownerTelegramChatId, text);
      return true;
    } catch (error) {
      logged("AGENT_GROUP_CONNECTION_NOTICE_FAILED", error, groupId);
      return false;
    }
  };

  return {
    async disconnect(input: OwnerRequest) {
      const result = await dependencies.repository.disconnect(input);
      const base = { telegramChatId: result.telegramChatId, title: result.title };
      if (result.status === "already_disconnected") {
        return { ...base, status: result.status, nextStep: "Tell the owner in one line that this group was already disconnected." };
      }
      console.info(JSON.stringify({ code: "AGENT_GROUP_DISCONNECTED", groupId: result.groupId, reason: "owner" }));
      await afterChange(result.groupId, true);
      const sent = await confirm(input.ownerTelegramChatId, groupDisconnectedNotice(result.title), result.groupId);
      return { ...base, ownerNotified: sent, status: result.status, nextStep: sent ? CONFIRMATION_SENT_STEP : DISCONNECTED_UNSENT_STEP };
    },

    async remove(input: OwnerRequest) {
      // Raw copies of another family's chat must never be touched: the group is the family's first.
      const found = await dependencies.repository.find(input);
      if (found === null) {
        throw new AppError("AGENT_GROUP_NOT_FOUND", "Группа не найдена в вашей семье. Проверьте идентификатор Telegram-чата");
      }
      const purged = await dependencies.purgeIngressCopies(input.telegramChatId);
      const removed = await dependencies.removeRegistration(input);
      console.info(JSON.stringify({ code: "AGENT_GROUP_REMOVED", groupId: removed.groupId, purgedIngressCopies: purged }));
      try {
        await dependencies.purgeIngressCopies(input.telegramChatId);
      } catch (error) {
        logged("AGENT_GROUP_INGRESS_PURGE_FAILED", error, removed.groupId);
      }
      try {
        await dependencies.stopSandboxThreads(removed.sandboxThreadIds);
      } catch (error) {
        logged("AGENT_GROUP_SANDBOX_STOP_FAILED", error, removed.groupId);
      }
      await afterChange(removed.groupId, false);
      const sent = await confirm(input.ownerTelegramChatId, groupRemovedNotice(removed.title), removed.groupId);
      return {
        ownerNotified: sent,
        status: "removed" as const,
        telegramChatId: input.telegramChatId,
        title: removed.title,
        nextStep: sent ? CONFIRMATION_SENT_STEP : REMOVED_UNSENT_STEP,
      };
    },

    async reconnect(input: OwnerRequest) {
      const found = await dependencies.repository.find(input);
      if (found === null) {
        throw new AppError("AGENT_GROUP_NOT_FOUND", "Группа с таким telegramChatId не зарегистрирована в вашей семье. Посмотрите список групп и повторите с её telegramChatId");
      }
      if (found.type === "external" && found.disconnectedAt !== null && !await dependencies.telegram.botIsMember(input.telegramChatId)) {
        throw new AppError(
          "AGENT_GROUP_BOT_NOT_MEMBER",
          `Меня нет в группе «${found.title}». Добавьте меня в группу и попросите подключить снова`,
        );
      }
      const result = await dependencies.repository.reconnect(input);
      const base = { telegramChatId: result.telegramChatId, title: result.title };
      if (result.status === "already_connected") {
        return { ...base, status: result.status, nextStep: "Tell the owner in one line that this group is already connected." };
      }
      console.info(JSON.stringify({ code: "AGENT_GROUP_RECONNECTED", groupId: result.groupId }));
      await afterChange(result.groupId, false);
      const sent = await confirm(input.ownerTelegramChatId, groupReconnectedNotice(result.title), result.groupId);
      return { ...base, ownerNotified: sent, status: result.status, nextStep: sent ? CONFIRMATION_SENT_STEP : RECONNECTED_UNSENT_STEP };
    },
  };
}

export const groupConnectionActions = createGroupConnectionActions({
  publishApiKeys: () => apiKeyPublisher.publish(),
  purgeIngressCopies: purgeChatIngressCopies,
  removeRegistration: (input) => telegramGroupAdministrationRepository.removeRegistration(input),
  stopSandboxThreads,
  repository: groupConnectionRepository,
  async stopSandboxes(groupId) {
    const client = await database().connect();
    try {
      await stopGroupSandboxes(client, groupId);
    } finally {
      client.release();
    }
  },
  telegram: groupConnectionTelegram,
});
