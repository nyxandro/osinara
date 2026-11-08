/**
 * Guests of the family in PostgreSQL (#471): what the owner sees and changes, and the live policy a guest's
 * turn is built from.
 *
 * Exports:
 * - `GuestAccessPolicy`, `loadGuestAccessPolicy`: whether a family is a guest's own, what its owner turned off for
 *   that guest, and which skills and API keys of the owner's they were given (#474); read on every step, so a change
 *   works from the guest's next step.
 * - `GuestSummary`, `guestRepository`: the owner's list, the limits and the skills they set, removing a guest.
 *
 * Every owner operation re-reads the owner's role in the same transaction, like the family invitations do.
 */
import type { Pool, PoolClient } from "pg";

import { FAMILY_SKILLS_LOCK_HASH_SEED } from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { grantableFamilySkills } from "../family-skills/family-skill-repository.js";
import { guestSkillKeyNeeds, type SkillKeyNeed } from "./guest-skill-key-needs.js";

export interface GuestAccessPolicy {
  readonly active: boolean;
  readonly disabledSkills: ReadonlySet<string>;
  readonly disabledTools: ReadonlySet<string>;
  /** Names of the owner's stored API keys granted to the guest's folders. */
  readonly grantedApiKeys: readonly string[];
  /** Names of the owner's library skills given to the guest. */
  readonly grantedSkills: ReadonlySet<string>;
  readonly guestUserId: string;
  /** The family of the owner who let the guest in: where the given skills and keys live. */
  readonly hostFamilyId: string;
}

export interface GuestApiKeySummary {
  readonly lastUsedAt: string | null;
  readonly name: string;
  readonly uses: number;
  readonly usesLast7Days: number;
}

export interface GuestSummary {
  readonly apiKeys: readonly GuestApiKeySummary[];
  readonly disabledSkills: readonly string[];
  readonly disabledTools: readonly string[];
  readonly displayName: string;
  readonly grantedSkills: readonly string[];
  readonly guestUserId: string;
  readonly joinedAt: string;
  /** Names of the skills the guest saved for themselves, without their content. */
  readonly ownSkills: readonly string[];
  readonly revokedAt: string | null;
  /** Given skills that name an API key of the owner the guest was not granted. */
  readonly skillsNeedingKeys: readonly SkillKeyNeed[];
  readonly status: "active" | "revoked";
  readonly username: string | null;
}

interface GuestOwnerInput {
  readonly hostFamilyId: string;
  readonly ownerUserId: string;
}

type Queryable = Pick<Pool | PoolClient, "query">;

/** The stored keys of the host family granted to the folders of the guest's family; `guest` is a guest_accounts row. */
const GRANTED_API_KEYS = `COALESCE(ARRAY(
  SELECT DISTINCT api_key.name
    FROM sandbox_api_key_grants AS key_grant
    JOIN sandbox_api_keys AS api_key ON api_key.id = key_grant.key_id
    JOIN workspaces AS folder ON folder.id = key_grant.workspace_id
   WHERE folder.family_id = guest.guest_family_id AND api_key.family_id = guest.host_family_id
     AND key_grant.revoked_at IS NULL AND api_key.value_stored_at IS NOT NULL
   ORDER BY api_key.name), '{}')`;

/** The guest whose own family this is; null for every other family, the owner's included. */
export async function loadGuestAccessPolicy(familyId: string, queryable: Queryable = database()): Promise<GuestAccessPolicy | null> {
  const result = await queryable.query<{
    disabled_skills: string[];
    disabled_tools: string[];
    granted_api_keys: string[];
    granted_skills: string[];
    host_family_id: string;
    status: "active" | "revoked";
    user_id: string;
  }>(
    `SELECT guest.user_id, guest.status, guest.disabled_tools, guest.disabled_skills, guest.granted_skills,
            guest.host_family_id, ${GRANTED_API_KEYS} AS granted_api_keys
       FROM guest_accounts AS guest
      WHERE guest.guest_family_id = $1`,
    [familyId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    active: row.status === "active",
    disabledSkills: new Set(row.disabled_skills),
    disabledTools: new Set(row.disabled_tools),
    grantedApiKeys: row.granted_api_keys,
    grantedSkills: new Set(row.granted_skills),
    guestUserId: row.user_id,
    hostFamilyId: row.host_family_id,
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

function skillsUnknown(reason: string, unknown: readonly string[], next = "Возьмите имена из списка гостей"): AppError {
  return new AppError("AGENT_GUEST_SKILL_UNKNOWN", `${reason}: ${unknown.join(", ")}. ${next}`, {
    details: { unknown: unknown.join(",") },
  });
}

/** The owner's API keys granted to each guest of the host family, with the use of each active grant. */
async function guestApiKeys(client: PoolClient, hostFamilyId: string, guestUserId?: string): Promise<Map<string, GuestApiKeySummary[]>> {
  const rows = (await client.query<{ last_used_at: Date | null; name: string; user_id: string; uses: number; uses_last_7_days: number }>(
    `SELECT guest.user_id, api_key.name,
            count(usage.id)::integer AS uses,
            (count(usage.id) FILTER (WHERE usage.used_at > now() - interval '7 days'))::integer AS uses_last_7_days,
            max(usage.used_at) AS last_used_at
       FROM guest_accounts AS guest
       JOIN workspaces AS folder ON folder.family_id = guest.guest_family_id
       JOIN sandbox_api_key_grants AS key_grant ON key_grant.workspace_id = folder.id AND key_grant.revoked_at IS NULL
       JOIN sandbox_api_keys AS api_key ON api_key.id = key_grant.key_id AND api_key.family_id = guest.host_family_id
       LEFT JOIN sandbox_api_key_usage AS usage ON usage.grant_id = key_grant.id
      WHERE guest.host_family_id = $1 AND ($2::uuid IS NULL OR guest.user_id = $2)
      GROUP BY guest.user_id, api_key.name
      ORDER BY api_key.name`,
    [hostFamilyId, guestUserId ?? null],
  )).rows;
  const byGuest = new Map<string, GuestApiKeySummary[]>();
  for (const row of rows) {
    byGuest.set(row.user_id, [...byGuest.get(row.user_id) ?? [], {
      lastUsedAt: row.last_used_at?.toISOString() ?? null, name: row.name, uses: row.uses, usesLast7Days: row.uses_last_7_days,
    }]);
  }
  return byGuest;
}

export const guestRepository = {
  async listGuests(input: GuestOwnerInput): Promise<{
    readonly guests: readonly GuestSummary[];
    /** The library skills with a current version: what can be given to a guest. */
    readonly hostSkills: readonly string[];
    readonly openInvitations: readonly { readonly expiresAt: string }[];
  }> {
    return await inOwnerTransaction(input, async (client) => {
      const guests = await client.query<{
        created_at: Date;
        disabled_skills: string[];
        disabled_tools: string[];
        display_name: string;
        granted_skills: string[];
        own_skills: string[];
        revoked_at: Date | null;
        status: "active" | "revoked";
        telegram_username: string | null;
        user_id: string;
      }>(
        `SELECT guest.user_id, guest.status, guest.disabled_tools, guest.disabled_skills, guest.granted_skills,
                guest.created_at, guest.revoked_at, guest_user.display_name, guest_user.telegram_username,
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
      const apiKeys = await guestApiKeys(client, input.hostFamilyId);
      const needs = await guestSkillKeyNeeds(client, input.hostFamilyId, guests.rows.map((row) => ({
        apiKeys: (apiKeys.get(row.user_id) ?? []).map((key) => key.name),
        grantedSkills: row.granted_skills,
        guestUserId: row.user_id,
      })));
      return {
        guests: guests.rows.map((row) => ({
          apiKeys: apiKeys.get(row.user_id) ?? [],
          disabledSkills: row.disabled_skills,
          disabledTools: row.disabled_tools,
          displayName: row.display_name,
          grantedSkills: row.granted_skills,
          guestUserId: row.user_id,
          joinedAt: row.created_at.toISOString(),
          ownSkills: row.own_skills,
          revokedAt: row.revoked_at?.toISOString() ?? null,
          skillsNeedingKeys: needs.get(row.user_id) ?? [],
          status: row.status,
          username: row.telegram_username,
        })),
        hostSkills: [...(await grantableFamilySkills(client, input.hostFamilyId)).keys()].sort(),
        openInvitations: invitations.rows.map((row) => ({ expiresAt: row.expires_at.toISOString() })),
      };
    });
  },

  /**
   * Replaces the lists the call gives and keeps the others: what the owner turned off (tool names checked by the
   * caller against the guest's tool set, skill names here against the built-in skills and the guest's own ones),
   * and the owner's library skills given to the guest (#474), checked here against the library.
   */
  async configureGuest(input: GuestTarget & {
    readonly builtInSkills: ReadonlySet<string>;
    readonly disabledSkills?: readonly string[];
    readonly disabledTools?: readonly string[];
    readonly grantedSkills?: readonly string[];
  }): Promise<{
    readonly disabledSkills: readonly string[];
    readonly disabledTools: readonly string[];
    readonly grantedSkills: readonly string[];
    readonly skillsNeedingKeys: readonly SkillKeyNeed[];
  }> {
    return await inOwnerTransaction(input, async (client) => {
      if (input.grantedSkills !== undefined) {
        // The library's lock before the guest's row, in the order of every skill change: a skill deleted meanwhile
        // cannot stay given and pass to a later skill under its name.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [input.hostFamilyId, FAMILY_SKILLS_LOCK_HASH_SEED]);
      }
      const guestFamilyId = await lockedGuestFamily(client, input);
      const ownSkills = await grantableFamilySkills(client, guestFamilyId);
      if (input.disabledSkills !== undefined) {
        const unknown = input.disabledSkills.filter((name) => !input.builtInSkills.has(name) && !ownSkills.has(name));
        if (unknown.length > 0) throw skillsUnknown("Нет такого скилла среди встроенных и скиллов гостя", unknown);
      }
      if (input.grantedSkills !== undefined) {
        const library = await grantableFamilySkills(client, input.hostFamilyId);
        const unknown = input.grantedSkills.filter((name) => !library.has(name));
        if (unknown.length > 0) {
          throw skillsUnknown("Нет такого скилла в вашей библиотеке", unknown, "Возьмите имена из hostSkills списка гостей");
        }
        const clash = input.grantedSkills.filter((name) => ownSkills.has(name));
        if (clash.length > 0) {
          throw new AppError(
            "AGENT_GUEST_SKILL_NAME_CONFLICT",
            `У гостя уже есть свой скилл ${clash.join(", ")}. Выдать ваш скилл с тем же именем нельзя, пока гость не переименует или не удалит свой`,
            { details: { names: clash.join(",") } },
          );
        }
      }
      const sorted = (names: readonly string[] | undefined) => names === undefined ? null : [...new Set(names)].sort();
      const updated = await client.query<{ disabled_skills: string[]; disabled_tools: string[]; granted_skills: string[] }>(
        // A name given is never also turned off: one left there from a skill of the guest's own that is gone would
        // hide the given skill without a word.
        `UPDATE guest_accounts
            SET disabled_tools = COALESCE($2, disabled_tools),
                disabled_skills = ARRAY(SELECT off.name FROM unnest(COALESCE($3, disabled_skills)) AS off(name)
                                         WHERE off.name <> ALL (COALESCE($4, granted_skills)) ORDER BY off.name),
                granted_skills = COALESCE($4, granted_skills), updated_at = now()
          WHERE user_id = $1
          RETURNING disabled_tools, disabled_skills, granted_skills`,
        [input.guestUserId, sorted(input.disabledTools), sorted(input.disabledSkills), sorted(input.grantedSkills)],
      );
      const lists = updated.rows[0]!;
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'guest.configured', $3,
                 jsonb_build_object('disabledTools', $4::text[], 'disabledSkills', $5::text[], 'grantedSkills', $6::text[]))`,
        [input.hostFamilyId, input.ownerUserId, input.guestUserId, lists.disabled_tools, lists.disabled_skills, lists.granted_skills],
      );
      const apiKeys = (await guestApiKeys(client, input.hostFamilyId, input.guestUserId)).get(input.guestUserId) ?? [];
      const needs = await guestSkillKeyNeeds(client, input.hostFamilyId, [{
        apiKeys: apiKeys.map((key) => key.name), grantedSkills: lists.granted_skills, guestUserId: input.guestUserId,
      }]);
      return {
        disabledSkills: lists.disabled_skills,
        disabledTools: lists.disabled_tools,
        grantedSkills: lists.granted_skills,
        skillsNeedingKeys: needs.get(input.guestUserId) ?? [],
      };
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
