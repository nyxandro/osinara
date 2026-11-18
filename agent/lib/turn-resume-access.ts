/**
 * Whether recovery may finish an interrupted turn (#542).
 *
 * Export:
 * - `turnResumeAccess`: "allowed" or "revoked" for a turn's recorded auth, read against the current records.
 *
 * A turn records its rights when it is created. Recovery finishes it after a restart, possibly minutes later:
 * AGENTS.md wants rights re-checked at execution, so a person removed from the family, a revoked guest or a
 * disconnected group meanwhile must not get the answer. Every Telegram turn is checked here — a message, a
 * wake-up, a scheduled run, a background task's report, a private question, an approval's continuation; a
 * memory review and a background task's own turn re-check their own rights. The rules mirror the approval's
 * re-check (`telegram-hitl/approval-auth.ts`), and fail closed where a turn's shape is not one Osinara writes.
 */
import type { SessionAuth } from "../runtime/context.js";
import { database } from "./database.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function text(value: string | readonly string[] | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

interface Person { readonly guestRevoked: boolean; readonly role: string | null }

async function personIn(familyId: string, userId: string): Promise<Person> {
  const result = await database().query<{ guest_revoked: boolean; role: string | null }>(
    `SELECT (SELECT role::text FROM family_memberships WHERE family_id = $1 AND user_id = $2) AS role,
            EXISTS (SELECT 1 FROM guest_accounts WHERE guest_family_id = $1 AND user_id = $2 AND status <> 'active') AS guest_revoked`,
    [familyId, userId],
  );
  return { guestRevoked: result.rows[0]!.guest_revoked, role: result.rows[0]!.role };
}

export async function turnResumeAccess(auth: SessionAuth): Promise<"allowed" | "revoked"> {
  const current = auth.current;
  if (current === null || current.authenticator !== "telegram") return "allowed";
  const familyId = text(current.attributes.familyId);
  // A Telegram turn always names its family; one that does not cannot be checked, so it does not resume.
  if (familyId === null || !UUID.test(familyId)) return "revoked";
  // A family member is a user with a record; a participant outside the family, a bot or a channel is not.
  const userId = current.principalType === "user" && UUID.test(current.principalId) ? current.principalId : null;
  const person = userId === null ? null : await personIn(familyId, userId);
  const member = person !== null && person.role !== null && !person.guestRevoked;
  const groupId = text(current.attributes.groupId);
  if (groupId === null) return member ? "allowed" : "revoked";
  const group = await database().query<{ message_mode: string; type: string }>(
    "SELECT type::text, message_mode::text FROM telegram_groups WHERE id = $1 AND family_id = $2 AND disconnected_at IS NULL",
    [groupId, familyId],
  );
  const row = group.rows[0];
  if (row === undefined) return "revoked";
  if (row.type !== "external") return member ? "allowed" : "revoked";
  // An external group answers anyone in it, but a family member's turn carries that member's role: one who
  // left the family does not resume with it, and an owner-only group answers its owner alone.
  if (userId !== null && !member) return "revoked";
  if (row.message_mode === "owner_only" && person?.role !== "owner") return "revoked";
  return "allowed";
}
