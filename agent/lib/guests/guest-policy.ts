/**
 * The live guest policy of a session (#471).
 *
 * Export:
 * - `SessionGuest`, `guestPolicyFor`: the policy of the session's family when that family is a guest's own,
 *   or null for anyone who is not a guest. Read on every step, so the owner's change works from the next one.
 *
 * Kept apart from the tool surface, so the skill and instruction resolvers can read it without loading tools.
 */
import type { SessionAuth } from "../../runtime/context.js";
import { loadGuestAccessPolicy, type GuestAccessPolicy } from "./guest-repository.js";

export interface SessionGuest {
  readonly familyId: string;
  readonly policy: GuestAccessPolicy;
}

export async function guestPolicyFor(auth: SessionAuth): Promise<SessionGuest | null> {
  // A guest is defined by the family their session runs in: a session without a family is nobody's guest.
  const familyId = auth.current?.attributes.familyId;
  if (typeof familyId !== "string") return null;
  const policy = await loadGuestAccessPolicy(familyId);
  return policy === null ? null : { familyId, policy };
}
