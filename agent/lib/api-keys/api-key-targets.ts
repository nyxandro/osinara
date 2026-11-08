/**
 * Who a sandbox API key is granted to, and the workspace that grant lands in.
 *
 * Exports:
 * - `ApiKeyTarget`: the owner's personal folder, the whole family, one external group, or one guest of the family
 *   (#474).
 * - `targetWorkspace`: the workspace a target names. A grant creates it on first use like any other workspace; a
 *   revocation only looks it up and gets null when it was never created.
 *
 * A guest's grant lands in the guest's own personal folder, in the guest's own family: the only sandbox that mounts
 * it runs on a network of its own (#471), so the proxy accepts the grant from nowhere else.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { guestNotFound } from "../guests/guest-repository.js";

export type ApiKeyTarget =
  | { readonly kind: "family" }
  | { readonly kind: "group"; readonly telegramChatId: string }
  | { readonly guestDisplayName: string; readonly guestUserId: string; readonly kind: "guest" }
  | { readonly kind: "personal" };

/** The folder's identity: its family, scope, person and group. */
interface FolderKey {
  readonly familyId: string;
  readonly groupId: string | null;
  readonly ownerUserId: string | null;
  readonly scope: "family" | "group" | "personal";
}

async function externalGroupId(client: PoolClient, familyId: string, telegramChatId: string): Promise<string> {
  const group = await client.query<{ id: string }>(
    `SELECT id FROM telegram_groups
      WHERE family_id = $1 AND telegram_chat_id = $2 AND type = 'external'`,
    [familyId, telegramChatId],
  );
  if (!group.rows[0]) {
    throw new AppError(
      "AGENT_API_KEY_GROUP_NOT_FOUND",
      "Такой внешней группы нет в вашей семье. Для семейных групп выдайте ключ всей семье",
      { details: { telegramChatId } },
    );
  }
  return group.rows[0].id;
}

/**
 * The guest's own family, when the guest is the key family's own and still carries the name the card showed. A
 * removed guest gets no new grant, which would only wait unseen for their return; one they had can be taken back.
 */
async function guestFamilyId(
  client: PoolClient,
  hostFamilyId: string,
  target: { guestDisplayName: string; guestUserId: string },
  granting: boolean,
): Promise<string> {
  const guest = await client.query<{ guest_family_id: string; status: "active" | "revoked" }>(
    `SELECT guest.guest_family_id, guest.status
       FROM guest_accounts AS guest
       JOIN users AS guest_user ON guest_user.id = guest.user_id
      WHERE guest.user_id = $1 AND guest.host_family_id = $2 AND guest_user.display_name = $3
      FOR SHARE OF guest`,
    [target.guestUserId, hostFamilyId, target.guestDisplayName],
  );
  if (!guest.rows[0]) throw guestNotFound();
  if (granting && guest.rows[0].status !== "active") {
    throw new AppError(
      "AGENT_GUEST_REMOVED",
      "Этот гость убран: выдать ему ключ нельзя. Выданное раньше вернётся к нему, если он придёт по новой ссылке",
    );
  }
  return guest.rows[0].guest_family_id;
}

async function folderKey(
  client: PoolClient,
  input: { create: boolean; familyId: string; ownerUserId: string; target: ApiKeyTarget },
): Promise<FolderKey> {
  const { familyId, target } = input;
  if (target.kind === "guest") {
    const guestFamily = await guestFamilyId(client, familyId, target, input.create);
    return { familyId: guestFamily, groupId: null, ownerUserId: target.guestUserId, scope: "personal" };
  }
  if (target.kind === "group") {
    return { familyId, groupId: await externalGroupId(client, familyId, target.telegramChatId), ownerUserId: null, scope: "group" };
  }
  return { familyId, groupId: null, ownerUserId: target.kind === "personal" ? input.ownerUserId : null, scope: target.kind };
}

export async function targetWorkspace(
  client: PoolClient,
  input: { create: boolean; familyId: string; ownerUserId: string; target: ApiKeyTarget },
): Promise<string | null> {
  const key = await folderKey(client, input);
  const values = [key.familyId, key.ownerUserId, key.groupId, key.scope];
  const workspace = input.create
    ? await client.query<{ id: string }>(
      `INSERT INTO workspaces (family_id, owner_user_id, group_id, scope)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (family_id, scope, owner_user_id, group_id) DO UPDATE SET family_id = EXCLUDED.family_id
       RETURNING id`,
      values,
    )
    : await client.query<{ id: string }>(
      `SELECT id FROM workspaces
        WHERE family_id = $1 AND owner_user_id IS NOT DISTINCT FROM $2 AND group_id IS NOT DISTINCT FROM $3
          AND scope = $4`,
      values,
    );
  return workspace.rows[0]?.id ?? null;
}
