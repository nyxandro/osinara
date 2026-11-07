/**
 * Claiming a guest invitation, inside the transaction of `familyRepository.claimInvitation`.
 *
 * Exports:
 * - `GuestInvitationClaim`: a guest who joined or came back, with the chat to tell the inviting owner in.
 * - `claimGuestInvitation`: gives the claimant their own one-person family, or brings a removed guest of the
 *   same owner back into theirs.
 *
 * A guest is a `member` of a family of their own with no owner (#471): every check that separates families
 * already separates the guest's memory, files, skills and Google from the inviting family, and no owner-only
 * capability reaches them. `guest_accounts` links the guest to the family that invited them.
 */
import type { PoolClient } from "pg";

export interface GuestInvitationClaim {
  readonly guest: "joined" | "returned";
  /** The inviting owner's Telegram user id, which is also their private chat with the bot. */
  readonly hostOwnerTelegramUserId: string;
}

// Not shown anywhere: a family's name is not read by the application.
const GUEST_FAMILY_NAME = "guest";
// The guest link is approved by the owner who created it; the claim of this one link is the decision's operation,
// unique per owner like every invitation decision (`invitation_decision_operations`).
function guestClaimOperation(invitationId: string): string {
  return `guest-link:${invitationId}`;
}

interface GuestClaimInput {
  readonly createdBy: string;
  readonly guestUserId: string;
  readonly hostFamilyId: string;
  readonly invitationId: string;
  readonly telegramUserId: string;
}

/** Runs inside the caller's transaction, after the invitation row is locked; "invalid" leaves it to roll back. */
export async function claimGuestInvitation(
  client: PoolClient,
  input: GuestClaimInput,
): Promise<GuestInvitationClaim | "invalid"> {
  // A link outlives nothing: once its creator is no longer the owner, it admits nobody.
  const owner = await client.query<{ telegram_user_id: string }>(
    `SELECT owner_user.telegram_user_id
       FROM family_memberships AS membership
       JOIN users AS owner_user ON owner_user.id = membership.user_id
      WHERE membership.family_id = $1 AND membership.user_id = $2 AND membership.role = 'owner'
      FOR SHARE OF membership`,
    [input.hostFamilyId, input.createdBy],
  );
  const hostOwnerTelegramUserId = owner.rows[0]?.telegram_user_id;
  if (!hostOwnerTelegramUserId) return "invalid";

  // Anyone already in a family — the owner's or a live guest's own — is not made a guest again.
  const membership = await client.query("SELECT 1 FROM family_memberships WHERE user_id = $1", [input.guestUserId]);
  if (membership.rowCount) return "invalid";

  const existing = await client.query<{ guest_family_id: string; host_family_id: string }>(
    "SELECT guest_family_id, host_family_id FROM guest_accounts WHERE user_id = $1 FOR UPDATE",
    [input.guestUserId],
  );
  const previous = existing.rows[0];
  if (previous && previous.host_family_id !== input.hostFamilyId) return "invalid";

  let guestFamilyId: string;
  if (previous) {
    // A removed guest comes back into the family their records were sealed in, with the owner's limits kept.
    guestFamilyId = previous.guest_family_id;
    await client.query(
      `UPDATE guest_accounts
          SET status = 'active', revoked_at = NULL, revoked_by = NULL, invitation_id = $2, updated_at = now()
        WHERE user_id = $1`,
      [input.guestUserId, input.invitationId],
    );
  } else {
    const family = await client.query<{ id: string }>(
      "INSERT INTO families (name) VALUES ($1) RETURNING id",
      [GUEST_FAMILY_NAME],
    );
    guestFamilyId = family.rows[0]!.id;
    await client.query(
      `INSERT INTO guest_accounts (user_id, guest_family_id, host_family_id, invitation_id, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [input.guestUserId, guestFamilyId, input.hostFamilyId, input.invitationId],
    );
  }
  // The owner may approve this person's family claim at the same moment: the one family a person may have wins.
  const joined = await client.query(
    `INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'member')
     ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
    [guestFamilyId, input.guestUserId],
  );
  if (!joined.rowCount) return "invalid";
  await client.query(
    `UPDATE invitations
        SET status = 'approved', claimed_at = now(), claimed_by = $2,
            decided_at = now(), decided_by = $3, decision_operation_key = $4
      WHERE id = $1`,
    [input.invitationId, input.guestUserId, input.createdBy, guestClaimOperation(input.invitationId)],
  );
  const guest = previous ? "returned" : "joined";
  await client.query(
    `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
     VALUES ($1, $2, $3, $4, jsonb_build_object('telegramUserId', $5::text))`,
    [input.hostFamilyId, input.guestUserId, `guest.${guest}`, input.invitationId, input.telegramUserId],
  );
  return { guest, hostOwnerTelegramUserId };
}
