/**
 * Guests of the family in PostgreSQL (#471): what the owner sees and changes, and the live policy a guest's
 * turn is built from.
 *
 * Exports:
 * - `GuestAccessPolicy`, `loadGuestAccessPolicy`: whether a family is a guest's own, and what its owner turned
 *   off for that guest; read on every step, so a change works from the guest's next step.
 * - `GuestSummary`, `guestRepository`: the owner's list, the limits they set, removing a guest.
 *
 * Every owner operation re-reads the owner's role in the same transaction, like the family invitations do.
 */
import type { Pool, PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { grantableFamilySkills } from "../family-skills/family-skill-repository.js";

export interface GuestAccessPolicy {
  readonly active: boolean;
  readonly disabledSkills: ReadonlySet<string>;
  readonly disabledTools: ReadonlySet<string>;
  readonly guestUserId: string;
}

export interface GuestSummary {
  readonly disabledSkills: readonly string[];
  readonly disabledTools: readonly string[];
  readonly displayName: string;
  readonly guestUserId: string;
  readonly joinedAt: string;
  /** Names of the skills the guest saved for themselves, without their content. */
  readonly ownSkills: readonly string[];
  readonly revokedAt: string | null;
  readonly status: "active" | "revoked";
  readonly username: string | null;
}

interface GuestOwnerInput {
  readonly hostFamilyId: string;
  readonly ownerUserId: string;
}

type Queryable = Pick<Pool | PoolClient, "query">;

/** The guest whose own family this is; null for every other family, the owner's included. */
export async function loadGuestAccessPolicy(familyId: string, queryable: Queryable = database()): Promise<GuestAccessPolicy | null> {
  const result = await queryable.query<{
    disabled_skills: string[];
    disabled_tools: string[];
    status: "active" | "revoked";
    user_id: string;
  }>(
    `SELECT user_id, status, disabled_tools, disabled_skills
       FROM guest_accounts
      WHERE guest_family_id = $1`,
    [familyId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    active: row.status === "active",
    disabledSkills: new Set(row.disabled_skills),
    disabledTools: new Set(row.disabled_tools),
    guestUserId: row.user_id,
  };
}

export function guestNotFound(): AppError {
  return new AppError(
    "AGENT_GUEST_NOT_FOUND",
    "Такого гостя нет или его имя изменилось. Посмотрите список гостей заново и возьмите guestUserId и guestDisplayName оттуда",
  );
}

/** Who the owner confirms a change for: the card shows the name, the database rechecks it against the id. */
interface GuestTarget extends GuestOwnerInput {
  readonly guestDisplayName: string;
  readonly guestUserId: string;
}

async function requireLiveOwner(client: PoolClient, input: GuestOwnerInput): Promise<void> {
  // Session authorization is a snapshot; every change is made only while the owner role is live.
  const owner = await client.query(
    `SELECT 1 FROM family_memberships
      WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
      FOR SHARE`,
    [input.hostFamilyId, input.ownerUserId],
  );
  if (!owner.rowCount) throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
}

async function inOwnerTransaction<T>(input: GuestOwnerInput, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await requireLiveOwner(client, input);
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

async function lockedGuestFamily(client: PoolClient, input: GuestTarget): Promise<string> {
  const guest = await client.query<{ guest_family_id: string }>(
    `SELECT guest.guest_family_id
       FROM guest_accounts AS guest
       JOIN users AS guest_user ON guest_user.id = guest.user_id
      WHERE guest.user_id = $1 AND guest.host_family_id = $2 AND guest_user.display_name = $3
      FOR UPDATE OF guest`,
    [input.guestUserId, input.hostFamilyId, input.guestDisplayName],
  );
  const guestFamilyId = guest.rows[0]?.guest_family_id;
  if (!guestFamilyId) throw guestNotFound();
  return guestFamilyId;
}

export const guestRepository = {
  async listGuests(input: GuestOwnerInput): Promise<{
    readonly guests: readonly GuestSummary[];
    readonly openInvitations: readonly { readonly expiresAt: string }[];
  }> {
    return await inOwnerTransaction(input, async (client) => {
      const guests = await client.query<{
        created_at: Date;
        disabled_skills: string[];
        disabled_tools: string[];
        display_name: string;
        own_skills: string[];
        revoked_at: Date | null;
        status: "active" | "revoked";
        telegram_username: string | null;
        user_id: string;
      }>(
        `SELECT guest.user_id, guest.status, guest.disabled_tools, guest.disabled_skills, guest.created_at,
                guest.revoked_at, guest_user.display_name, guest_user.telegram_username,
                COALESCE(ARRAY(SELECT skill.name FROM family_skills AS skill
                                WHERE skill.family_id = guest.guest_family_id ORDER BY skill.name), '{}') AS own_skills
           FROM guest_accounts AS guest
           JOIN users AS guest_user ON guest_user.id = guest.user_id
          WHERE guest.host_family_id = $1
          ORDER BY guest.created_at, guest.user_id`,
        [input.hostFamilyId],
      );
      // A link nobody opened yet; one that is only being sent is not shown as ready.
      const invitations = await client.query<{ expires_at: Date }>(
        `SELECT expires_at FROM invitations
          WHERE family_id = $1 AND kind = 'guest' AND status = 'open' AND expires_at >= now()
            AND delivery_completed_at IS NOT NULL
          ORDER BY expires_at`,
        [input.hostFamilyId],
      );
      return {
        guests: guests.rows.map((row) => ({
          disabledSkills: row.disabled_skills,
          disabledTools: row.disabled_tools,
          displayName: row.display_name,
          guestUserId: row.user_id,
          joinedAt: row.created_at.toISOString(),
          ownSkills: row.own_skills,
          revokedAt: row.revoked_at?.toISOString() ?? null,
          status: row.status,
          username: row.telegram_username,
        })),
        openInvitations: invitations.rows.map((row) => ({ expiresAt: row.expires_at.toISOString() })),
      };
    });
  },

  /**
   * Replaces what the owner turned off for a guest. Tool names are checked by the caller against the guest's
   * tool set; skill names are checked here against the built-in skills and the guest's own ones.
   */
  async configureGuest(input: GuestTarget & {
    readonly builtInSkills: ReadonlySet<string>;
    readonly disabledSkills: readonly string[];
    readonly disabledTools: readonly string[];
  }): Promise<{ readonly disabledSkills: readonly string[]; readonly disabledTools: readonly string[] }> {
    return await inOwnerTransaction(input, async (client) => {
      const guestFamilyId = await lockedGuestFamily(client, input);
      const ownSkills = await grantableFamilySkills(client, guestFamilyId);
      const unknown = input.disabledSkills.filter((name) => !input.builtInSkills.has(name) && !ownSkills.has(name));
      if (unknown.length > 0) {
        throw new AppError(
          "AGENT_GUEST_SKILL_UNKNOWN",
          `Нет такого скилла среди встроенных и скиллов гостя: ${unknown.join(", ")}. Возьмите имена из списка гостей`,
          { details: { unknown: unknown.join(",") } },
        );
      }
      const disabledTools = [...new Set(input.disabledTools)].sort();
      const disabledSkills = [...new Set(input.disabledSkills)].sort();
      await client.query(
        `UPDATE guest_accounts
            SET disabled_tools = $2, disabled_skills = $3, updated_at = now()
          WHERE user_id = $1`,
        [input.guestUserId, disabledTools, disabledSkills],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'guest.configured', $3,
                 jsonb_build_object('disabledTools', $4::text[], 'disabledSkills', $5::text[]))`,
        [input.hostFamilyId, input.ownerUserId, input.guestUserId, disabledTools, disabledSkills],
      );
      return { disabledSkills, disabledTools };
    });
  },

  /**
   * Closes the guest's access: without their membership every message and waiting button of theirs is refused
   * by the checks that already require it. Their records stay sealed in their family. Their live reminders and
   * scenarios are paused first: the dispatchers fail an active one whose author lost membership and report each
   * failure as an incident, which would alert the owner about their own decision; paused ones they leave alone,
   * and a returning guest resumes them.
   */
  async revokeGuest(input: GuestTarget): Promise<{ readonly revoked: true }> {
    return await inOwnerTransaction(input, async (client) => {
      const guestFamilyId = await lockedGuestFamily(client, input);
      await client.query(
        "UPDATE reminders SET status = 'paused', updated_at = now() WHERE family_id = $1 AND status = 'active'",
        [guestFamilyId],
      );
      // A scenario under way finishes its run and then stays paused, as on the person's own pause.
      await client.query(
        `UPDATE agent_schedules
            SET status = CASE WHEN status = 'active' THEN 'paused'::agent_schedule_status ELSE status END,
                pause_requested = status = 'leased', updated_at = now()
          WHERE family_id = $1 AND status IN ('active', 'leased')`,
        [guestFamilyId],
      );
      const changed = await client.query(
        `UPDATE guest_accounts
            SET status = 'revoked', revoked_at = now(), revoked_by = $2, updated_at = now()
          WHERE user_id = $1 AND status = 'active'`,
        [input.guestUserId, input.ownerUserId],
      );
      await client.query(
        "DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2",
        [guestFamilyId, input.guestUserId],
      );
      if (changed.rowCount) {
        await client.query(
          `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
           VALUES ($1, $2, 'guest.revoked', $3, '{}'::jsonb)`,
          [input.hostFamilyId, input.ownerUserId, input.guestUserId],
        );
      }
      return { revoked: true };
    });
  },
};
