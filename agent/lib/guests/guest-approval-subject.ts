/**
 * The guest an owner's confirmation card names (#479).
 *
 * Exports:
 * - `GuestApprovalSubject`: the guest as their record and Telegram know them.
 * - `findGuestApprovalSubject`: a guest of the owner's own family by id, or null for anyone else.
 * - `guestApprovalLabel`: how the card names the guest; refuses a call that names them otherwise.
 *
 * The card is built from the record, not from the model's words: two guests may share a name, so the
 * name comes with the @username or, for a guest without one, the Telegram ID. The call names the guest
 * by id and name from the list and execution rechecks the pair (#474); a pair that would not match
 * gets no card, so the owner never confirms a change that would then be refused.
 */
import { database } from "../database.js";
import { guestNotFound } from "./guest-repository.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface GuestApprovalSubject {
  readonly displayName: string;
  readonly telegramUserId: string;
  readonly telegramUsername: string | null;
}

export async function findGuestApprovalSubject(input: {
  readonly guestUserId: string;
  readonly hostFamilyId: string;
}): Promise<GuestApprovalSubject | null> {
  // An id the model made up is nobody: it never reaches the uuid column as a database error.
  if (!UUID_PATTERN.test(input.guestUserId)) return null;
  const result = await database().query<{ display_name: string; telegram_user_id: string; telegram_username: string | null }>(
    `SELECT guest_user.display_name, guest_user.telegram_user_id, guest_user.telegram_username
       FROM guest_accounts AS guest
       JOIN users AS guest_user ON guest_user.id = guest.user_id
      WHERE guest.user_id = $1 AND guest.host_family_id = $2`,
    [input.guestUserId, input.hostFamilyId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : { displayName: row.display_name, telegramUserId: row.telegram_user_id, telegramUsername: row.telegram_username };
}

export function guestApprovalLabel(guest: GuestApprovalSubject | null, calledName: unknown): string {
  if (guest === null || guest.displayName !== calledName) throw guestNotFound();
  return `${guest.displayName} (${guest.telegramUsername ? `@${guest.telegramUsername}` : `Telegram ID ${guest.telegramUserId}`})`;
}
