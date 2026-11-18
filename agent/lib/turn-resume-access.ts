/**
 * Whether recovery may finish an interrupted turn (#542).
 *
 * Export:
 * - `turnResumeAccess`: "allowed" or "revoked" for a turn's recorded auth, read against the current records.
 *
 * A turn records its rights when it is created. Recovery finishes it after a restart, possibly minutes later:
 * AGENTS.md wants rights re-checked at execution, so a person removed from the family, a revoked guest or a
 * disconnected group meanwhile must not get the answer. Only Telegram turns are checked here; a memory review,
 * a private question and a background task re-check their own rights.
 */
import type { SessionAuth } from "../runtime/context.js";
import { database } from "./database.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function text(value: string | readonly string[] | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export async function turnResumeAccess(auth: SessionAuth): Promise<"allowed" | "revoked"> {
  const current = auth.current;
  if (current === null || current.authenticator !== "telegram") return "allowed";
  const familyId = text(current.attributes.familyId);
  // A Telegram turn always names its family; one that does not cannot be checked, so it does not resume.
  if (familyId === null || !UUID.test(familyId)) return "revoked";
  const groupId = text(current.attributes.groupId);
  const groupType = text(current.attributes.groupType);
  if (groupId !== null) {
    const group = await database().query(
      "SELECT 1 FROM telegram_groups WHERE id = $1 AND family_id = $2 AND disconnected_at IS NULL",
      [groupId, familyId],
    );
    if ((group.rowCount ?? 0) === 0) return "revoked";
    // Anyone in a connected external group is answered there: it holds only its own data.
    if (groupType === "external") return "allowed";
  }
  // A bot or a channel has no membership to lose; its chat was checked above.
  if (current.principalType !== "user" || !UUID.test(current.principalId)) return groupId === null ? "revoked" : "allowed";
  const person = await database().query<{ member: boolean; guest_revoked: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2) AS member,
            EXISTS (SELECT 1 FROM guest_accounts WHERE guest_family_id = $1 AND user_id = $2 AND status <> 'active') AS guest_revoked`,
    [familyId, current.principalId],
  );
  const row = person.rows[0]!;
  return row.member && !row.guest_revoked ? "allowed" : "revoked";
}
