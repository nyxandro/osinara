/**
 * Trusted family and group access policy.
 *
 * Exports:
 * - `FamilyRole`: authenticated family roles.
 * - `TelegramGroupMessageMode`: persisted group collection modes.
 * - `RegisteredGroup`: persisted Telegram group policy.
 * - `ConversationAccess`: scopes exposed to agent runtime code.
 * - `evaluateConversationAccess`: returns an explicit allow/deny decision.
 * - `resolveConversationAccess`: rejects unknown callers before model execution.
 */
import { AppError } from "./app-error.js";
import type { TelegramActorKind } from "./telegram-inbound-actor.js";

export type FamilyRole = "member" | "owner" | "recovery_owner";
export type RegisteredGroupType = "external" | "family_private";
export type TelegramGroupMessageMode = "addressed_only" | "all" | "owner_only";
export type StandardTelegramGroupMessageMode = Exclude<TelegramGroupMessageMode, "owner_only">;

export interface FamilyIdentity {
  familyId: string;
  role: FamilyRole;
  userId: string;
}

interface RegisteredGroupBase {
  familyId: string;
  groupId: string;
  skillAllowlist: string[];
  telegramChatId: string;
  toolAllowlist: string[];
}

export type RegisteredGroup = RegisteredGroupBase & (
  | {
    messageMode: StandardTelegramGroupMessageMode;
    type: "family_private";
  }
  | {
    messageMode: TelegramGroupMessageMode;
    type: "external";
  }
);

export interface ConversationAccess {
  familyId: string;
  groupId: string | null;
  memoryScopes: Array<"family" | "group" | "personal">;
  role: FamilyRole | "external";
  userId: string | null;
}

export interface ResolveConversationAccessInput {
  actorKind: TelegramActorKind;
  chat: {
    id: string;
    type: "group" | "private" | "supergroup";
  };
  identity: FamilyIdentity | null;
  registeredGroup: RegisteredGroup | null;
}

export type ConversationAccessDecision =
  | { access: ConversationAccess; allowed: true }
  | { allowed: false; error: AppError };

export function evaluateConversationAccess(
  input: ResolveConversationAccessInput,
): ConversationAccessDecision {
  // Private chats require a registered family identity and expose only that caller's scopes.
  if (input.chat.type === "private") {
    if (input.actorKind !== "telegram_user" || !input.identity) {
      return {
        allowed: false,
        error: new AppError(
          "AGENT_ACCESS_DENIED",
          "У вас нет доступа к этому семейному агенту. Попросите владельца отправить приглашение",
        ),
      };
    }

    return {
      access: {
        familyId: input.identity.familyId,
        groupId: null,
        memoryScopes: ["personal", "family"],
        role: input.identity.role,
        userId: input.identity.userId,
      },
      allowed: true,
    };
  }

  // Group identity comes only from a persisted registration, never from model-visible text.
  const group = input.registeredGroup;
  if (!group || group.telegramChatId !== input.chat.id) {
    return {
      allowed: false,
      error: new AppError("AGENT_GROUP_NOT_REGISTERED", "Эта группа не подключена к агенту"),
    };
  }

  // A family group is private to active members of the same family.
  if (group.type === "family_private") {
    if (input.actorKind !== "telegram_user" || !input.identity ||
      input.identity.familyId !== group.familyId) {
      return {
        allowed: false,
        error: new AppError(
          "AGENT_ACCESS_DENIED",
          "У вас нет доступа к семейной памяти этой группы",
        ),
      };
    }

    return {
      access: {
        familyId: group.familyId,
        groupId: group.groupId,
        memoryScopes: ["family"],
        role: input.identity.role,
        userId: input.identity.userId,
      },
      allowed: true,
    };
  }

  // A channel proves only its visible Telegram chat identity. It can participate in an external
  // group, but can never inherit the human owner behind that channel or satisfy owner-only mode.
  if (input.actorKind === "telegram_channel" && group.messageMode === "owner_only") {
    return {
      allowed: false,
      error: new AppError(
        "AGENT_TELEGRAM_CHANNEL_OWNER_REQUIRED",
        "Сообщения от имени канала недоступны в режиме только для владельца",
      ),
    };
  }

  // A bot participates only in the untrusted external zone, and owner-only mode is reserved for the
  // verified human owner. Neither this branch nor the family branch above can ever admit a bot.
  if (input.actorKind === "telegram_bot" && group.messageMode === "owner_only") {
    return {
      allowed: false,
      error: new AppError(
        "AGENT_TELEGRAM_BOT_NOT_ADMITTED",
        "Сообщения других ботов недоступны в режиме только для владельца",
      ),
    };
  }

  // External groups remain group-only, but a same-family identity is retained for owner administration.
  const familyIdentity = input.actorKind === "telegram_user" &&
    input.identity?.familyId === group.familyId ? input.identity : null;
  return {
    access: {
      familyId: group.familyId,
      groupId: group.groupId,
      memoryScopes: ["group"],
      role: familyIdentity?.role ?? "external",
      userId: familyIdentity?.userId ?? null,
    },
    allowed: true,
  };
}

export function resolveConversationAccess(input: ResolveConversationAccessInput): ConversationAccess {
  const decision = evaluateConversationAccess(input);
  if (!decision.allowed) throw decision.error;
  return decision.access;
}
