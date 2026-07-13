/**
 * Trusted family and group access policy.
 *
 * Exports:
 * - `FamilyRole`: authenticated family roles.
 * - `TelegramGroupMessageMode`: persisted group collection modes.
 * - `RegisteredGroup`: persisted Telegram group policy.
 * - `ConversationAccess`: scopes exposed to Eve runtime code.
 * - `evaluateConversationAccess`: returns an explicit allow/deny decision.
 * - `resolveConversationAccess`: rejects unknown callers before model execution.
 */
import { AppError } from "./app-error.js";

export type FamilyRole = "member" | "owner" | "recovery_owner";
export type RegisteredGroupType = "external_private" | "external_public" | "family_private";
export type TelegramGroupMessageMode = "addressed_only" | "all";

export interface FamilyIdentity {
  familyId: string;
  role: FamilyRole;
  userId: string;
}

export interface RegisteredGroup {
  familyId: string;
  groupId: string;
  messageMode: TelegramGroupMessageMode;
  telegramChatId: string;
  toolAllowlist: string[];
  type: RegisteredGroupType;
}

export interface ConversationAccess {
  familyId: string;
  groupId: string | null;
  memoryScopes: Array<"family" | "group" | "personal">;
  role: FamilyRole | "external";
  userId: string | null;
}

export interface ResolveConversationAccessInput {
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
    if (!input.identity) {
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
    if (!input.identity || input.identity.familyId !== group.familyId) {
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

  // External groups remain group-only, but a same-family identity is retained for owner administration.
  const familyIdentity =
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
