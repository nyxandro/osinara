/**
 * Current database authorization for resumed Telegram HITL turns.
 *
 * Exports:
 * - `ApprovalAuthRow`: approval/session fields required to rebuild trusted Eve auth.
 * - `resolveCurrentApprovalAuth`: revalidates identity, membership, group, and scopes.
 */
import type { SessionAuthContext } from "eve/context";
import type { PoolClient } from "pg";

type TelegramChatType = "group" | "private" | "supergroup";
type MemoryScope = "family" | "group" | "personal";
type FamilyRole = "member" | "owner" | "recovery_owner";
type GroupType = "external" | "family_private";

export interface ApprovalAuthRow {
  application_session_id: string;
  eve_session_id: string;
  expected_telegram_user_id: string;
  family_id: string;
  group_id: string | null;
  owner_user_id: string | null;
  scope: MemoryScope;
  telegram_chat_id: string;
  telegram_chat_type: TelegramChatType;
  telegram_message_id: string;
  telegram_message_thread_id: string | null;
}

interface IdentityRow {
  family_id: string;
  role: FamilyRole;
  user_id: string;
}

interface GroupRow {
  family_id: string;
  id: string;
  message_mode: "addressed_only" | "all" | "owner_only";
  tool_allowlist: string[];
  type: GroupType;
}

async function findIdentity(client: PoolClient, telegramUserId: string, familyId: string): Promise<IdentityRow | null> {
  const result = await client.query<IdentityRow>(
    `SELECT fm.family_id, fm.role, fm.user_id
       FROM users u
       JOIN family_memberships fm ON fm.user_id = u.id
      WHERE u.telegram_user_id = $1
        AND fm.family_id = $2`,
    [telegramUserId, familyId],
  );
  return result.rows[0] ?? null;
}

export async function resolveCurrentApprovalAuth(client: PoolClient, row: ApprovalAuthRow): Promise<SessionAuthContext | null> {
  const identity = await findIdentity(client, row.expected_telegram_user_id, row.family_id);
  let group: GroupRow | null = null;
  let memoryScopes: MemoryScope[];
  let role: FamilyRole | "external";
  let userId: string | null;

  // Personal approvals remain bound to the current session owner and active family membership.
  if (row.scope === "personal") {
    if (!identity || identity.user_id !== row.owner_user_id || identity.family_id !== row.family_id || row.telegram_chat_type !== "private") return null;
    memoryScopes = ["personal", "family"];
    role = identity.role;
    userId = identity.user_id;
  } else {
    const groupResult = await client.query<GroupRow>(
      `SELECT id, family_id, type, message_mode, tool_allowlist
         FROM telegram_groups
        WHERE id = $1 AND telegram_chat_id = $2`,
      [row.group_id, row.telegram_chat_id],
    );
    group = groupResult.rows[0] ?? null;
    if (!group || group.family_id !== row.family_id || row.telegram_chat_type === "private") return null;

    // Family groups require current membership; external groups retain identity only for members.
    const familyIdentity = identity?.family_id === group.family_id ? identity : null;
    if (group.type === "family_private") {
      if (!familyIdentity || row.scope !== "family") return null;
      memoryScopes = ["family"];
      role = familyIdentity.role;
      userId = familyIdentity.user_id;
    } else {
      if (row.scope !== "group") return null;
      // A parked approval cannot outlive owner-role revocation in an owner-only external group.
      if (group.message_mode === "owner_only" && familyIdentity?.role !== "owner") return null;
      memoryScopes = ["group"];
      role = familyIdentity?.role ?? "external";
      userId = familyIdentity?.user_id ?? null;
    }
  }

  // Only freshly read database policy enters the resumed Eve turn.
  return {
    attributes: {
      applicationSessionId: row.application_session_id,
      telegramApprovalContinuation: "true",
      osinaraTelegramResponseSessionId: row.eve_session_id,
      telegramApprovalScope: row.scope,
      familyId: row.family_id,
      memoryScopes,
      role,
      telegramChatId: row.telegram_chat_id,
      telegramChatType: row.telegram_chat_type,
      telegramMessageId: row.telegram_message_id,
      telegramActorId: row.expected_telegram_user_id,
      telegramActorKind: "telegram_user",
      ...(row.telegram_message_thread_id === null ? {} : { telegramMessageThreadId: row.telegram_message_thread_id }),
      telegramUserId: row.expected_telegram_user_id,
      ...(group ? { groupId: group.id, groupType: group.type } : {}),
      ...(group && group.type !== "family_private" ? { toolAllowlist: group.tool_allowlist } : {}),
    },
    authenticator: "telegram",
    principalId: userId ?? `telegram:${row.expected_telegram_user_id}`,
    principalType: "user",
  };
}
