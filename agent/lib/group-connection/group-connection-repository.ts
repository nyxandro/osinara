/**
 * Connection state of an external group: disconnected with everything kept, or connected (#465).
 *
 * Exports:
 * - `GroupDisconnectReason`: the owner disconnected the group, or the bot was removed from the chat.
 * - `groupConnectionRepository`: disconnect, look up and reconnect a family's group; record the bot's
 *   membership events from Telegram.
 * - `isTelegramGroupDisconnected`, `isGroupIdDisconnected`: the check a live path makes before it works
 *   for a group, by its chat or by its registration.
 *
 * Key constructs:
 * - A disconnected group keeps its row and all its data. Paths where the group takes part in work
 *   (incoming messages, turns, sends, schedules) treat it as gone; the owner's paths still see it.
 * - Disconnecting asks every canonical conversation of the group for a new model context, like
 *   `start_new_context`: after a pause the group resumes with its history, not a stale session.
 * - Every change takes the group's trust-zone lock, the same one registration and removal take.
 * - A membership event older than the last recorded one never changes the state: Telegram may deliver
 *   a retried event after a newer one.
 * - Reconnection keeps the last pause and the history position it falls after, so the agent can be told
 *   that it did not see what was written then.
 */
import type { PoolClient } from "pg";

import {
  SESSION_GROUP_ROTATION_LOCK_HASH_SEED,
  TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED,
} from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";

export type GroupDisconnectReason = "owner" | "bot_removed";

export interface GroupConnectionTarget {
  groupId: string;
  telegramChatId: string;
  title: string;
}

interface LockedGroup {
  disconnected_at: Date | null;
  family_id: string;
  id: string;
  title: string;
  type: string;
}

const NOT_FOUND_MESSAGE =
  "Группа с таким telegramChatId не зарегистрирована в вашей семье. Посмотрите список групп и повторите с её telegramChatId";

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function requireOwner(client: PoolClient, familyId: string, userId: string): Promise<void> {
  // Locked until commit, so a parked confirmation cannot outlive a revoked ownership.
  const owner = await client.query(
    "SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2 AND role = 'owner' FOR SHARE",
    [familyId, userId],
  );
  if (!owner.rowCount) throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
}

// `FOR NO KEY UPDATE`, not `FOR UPDATE`: a turn being prepared holds the rotation lock taken below and
// creates a session whose foreign key reads this row; the stronger lock would deadlock with it.
async function lockGroup(client: PoolClient, telegramChatId: string, familyId: string | null): Promise<LockedGroup | null> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [telegramChatId, TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED]);
  const result = await client.query<LockedGroup>(
    `SELECT id, family_id, title, type, disconnected_at
       FROM telegram_groups
      WHERE telegram_chat_id = $1 AND ($2::uuid IS NULL OR family_id = $2::uuid)
      FOR NO KEY UPDATE`,
    [telegramChatId, familyId],
  );
  return result.rows[0] ?? null;
}

function requireExternal(group: LockedGroup): void {
  if (group.type !== "external") {
    throw new AppError(
      "AGENT_GROUP_DISCONNECT_EXTERNAL_ONLY",
      "Отключать можно только внешние группы. Семейную группу можно удалить или ограничить её права",
    );
  }
}

async function markDisconnected(
  client: PoolClient,
  group: LockedGroup,
  reason: GroupDisconnectReason,
  requestedBy: string | null,
): Promise<void> {
  await client.query(
    `UPDATE telegram_groups
        SET disconnected_at = now(), disconnected_reason = $2, disconnected_by = $3
      WHERE id = $1`,
    [group.id, reason, requestedBy],
  );
  // The same group-wide lock session preparation takes before choosing a canonical generation.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [group.id, SESSION_GROUP_ROTATION_LOCK_HASH_SEED]);
  await client.query(
    `UPDATE conversation_sessions SET rotation_requested_at = now()
      WHERE family_id = $1 AND group_id = $2 AND kind = 'canonical' AND retired_at IS NULL`,
    [group.family_id, group.id],
  );
}

function target(group: LockedGroup, telegramChatId: string): GroupConnectionTarget {
  return { groupId: group.id, telegramChatId, title: group.title };
}

export const groupConnectionRepository = {
  async disconnect(input: { familyId: string; requestedBy: string; telegramChatId: string }): Promise<
    GroupConnectionTarget & { status: "already_disconnected" | "disconnected" }
  > {
    return await inTransaction(async (client) => {
      await requireOwner(client, input.familyId, input.requestedBy);
      const group = await lockGroup(client, input.telegramChatId, input.familyId);
      if (!group) throw new AppError("AGENT_GROUP_NOT_FOUND", NOT_FOUND_MESSAGE);
      requireExternal(group);
      if (group.disconnected_at !== null) return { ...target(group, input.telegramChatId), status: "already_disconnected" };
      await markDisconnected(client, group, "owner", input.requestedBy);
      return { ...target(group, input.telegramChatId), status: "disconnected" };
    });
  },

  /** The group as the owner's reconnection sees it, before Telegram is asked about the bot. */
  async find(input: { familyId: string; telegramChatId: string }): Promise<
    (GroupConnectionTarget & { disconnectedAt: Date | null; type: string }) | null
  > {
    const result = await database().query<{ disconnected_at: Date | null; id: string; title: string; type: string }>(
      "SELECT id, title, type, disconnected_at FROM telegram_groups WHERE family_id = $1 AND telegram_chat_id = $2",
      [input.familyId, input.telegramChatId],
    );
    const row = result.rows[0];
    return row
      ? { disconnectedAt: row.disconnected_at, groupId: row.id, telegramChatId: input.telegramChatId, title: row.title, type: row.type }
      : null;
  },

  async reconnect(input: { familyId: string; requestedBy: string; telegramChatId: string }): Promise<
    GroupConnectionTarget & ({ status: "already_connected" } | { disconnectedAt: Date; reconnectedAt: Date; status: "reconnected" })
  > {
    return await inTransaction(async (client) => {
      await requireOwner(client, input.familyId, input.requestedBy);
      const group = await lockGroup(client, input.telegramChatId, input.familyId);
      if (!group) throw new AppError("AGENT_GROUP_NOT_FOUND", NOT_FOUND_MESSAGE);
      requireExternal(group);
      if (group.disconnected_at === null) return { ...target(group, input.telegramChatId), status: "already_connected" };
      // The pause is kept with the history position it falls after, for the agent to know the gap.
      const reconnected = await client.query<{ reconnected_at: Date }>(
        `UPDATE telegram_groups
            SET disconnected_at = NULL, disconnected_reason = NULL, disconnected_by = NULL,
                last_pause_started_at = $2, last_pause_ended_at = now(),
                last_pause_after_sequence = (
                  SELECT coalesce(max(message.sequence_id), 0)
                    FROM application_conversations AS conversation
                    JOIN telegram_group_messages AS message ON message.conversation_id = conversation.id
                   WHERE conversation.telegram_group_id = $1
                )
          WHERE id = $1
          RETURNING now() AS reconnected_at`,
        [group.id, group.disconnected_at],
      );
      return {
        ...target(group, input.telegramChatId),
        disconnectedAt: group.disconnected_at,
        reconnectedAt: reconnected.rows[0]!.reconnected_at,
        status: "reconnected",
      };
    });
  },

  /**
   * Records Telegram's news that the bot left or rejoined a registered group. Removal disconnects a
   * connected external group; rejoining a disconnected one only reports it — the owner reconnects.
   */
  async recordBotMembership(input: { changedAt: Date; member: boolean; telegramChatId: string }): Promise<
    | { change: "none" }
    | (GroupConnectionTarget & { change: "disconnected" | "rejoined_while_disconnected"; familyId: string })
  > {
    return await inTransaction(async (client) => {
      const group = await lockGroup(client, input.telegramChatId, null);
      if (!group) return { change: "none" };
      const recorded = await client.query(
        `UPDATE telegram_groups SET bot_membership_changed_at = $2
          WHERE id = $1 AND (bot_membership_changed_at IS NULL OR bot_membership_changed_at < $2)`,
        [group.id, input.changedAt],
      );
      if (!recorded.rowCount || group.type !== "external") return { change: "none" };
      if (!input.member && group.disconnected_at === null) {
        await markDisconnected(client, group, "bot_removed", null);
        return { ...target(group, input.telegramChatId), change: "disconnected", familyId: group.family_id };
      }
      if (input.member && group.disconnected_at !== null) {
        return { ...target(group, input.telegramChatId), change: "rejoined_while_disconnected", familyId: group.family_id };
      }
      return { change: "none" };
    });
  },
};

// Telegram gives groups and supergroups negative ids; a private chat is never a group.
const GROUP_CHAT_ID_PATTERN = /^-\d+$/u;

export async function isTelegramGroupDisconnected(telegramChatId: string): Promise<boolean> {
  if (!GROUP_CHAT_ID_PATTERN.test(telegramChatId)) return false;
  const result = await database().query(
    "SELECT 1 FROM telegram_groups WHERE telegram_chat_id = $1 AND disconnected_at IS NOT NULL",
    [telegramChatId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function isGroupIdDisconnected(groupId: string): Promise<boolean> {
  const result = await database().query(
    "SELECT 1 FROM telegram_groups WHERE id = $1 AND disconnected_at IS NOT NULL",
    [groupId],
  );
  return (result.rowCount ?? 0) > 0;
}
