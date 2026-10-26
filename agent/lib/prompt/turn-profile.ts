/**
 * The profile part of a turn's memory.
 *
 * Exports:
 * - `TurnProfile`: what the turn's own block and the history receive, with numbers for the log.
 * - `resolveTurnProfile`: builds them from the verified profile input and the session history.
 *
 * Key construct:
 * - A conversation turn keeps its profile in history as a card. Repeated every turn as a fresh
 *   block, the same facts read to the model as what matters and it brought them up unasked; living
 *   one turn, a fact left out was not in front of the model at all. So a fact a card in history
 *   still holds is not sent again, and one memory no longer gives is withdrawn. A turn with no
 *   window of its own (a delegated child, a scheduled run) has no conversation to keep a card in
 *   and gets the whole profile in its own block.
 */
import type { ModelMessage } from "ai";

import type { MemoryAuthorization } from "../memory-context.js";
import {
  formatProfileViewContext,
  type CreateProfileViewInput,
  type ProfileView,
} from "../profile-view.js";
import { formatProfileCard, formatProfilePeople, profilePersonKey, readProfileCards } from "./profile-card.js";

export interface TurnProfile {
  /** Its part of the turn's own block: the people with their refs, or the whole profile. */
  context: string | null;
  /** The card the turn writes into history, or `null` when it would add nothing. */
  card: string | null;
  characters: number;
  claimsInContext: number;
  memoryRefs: string[];
  withdrawnClaims: number;
}

const NO_PROFILE: TurnProfile = {
  card: null, characters: 0, claimsInContext: 0, context: null, memoryRefs: [], withdrawnClaims: 0,
};

export async function resolveTurnProfile(input: {
  authorization: MemoryAuthorization;
  createProfile: (auth: MemoryAuthorization, input: CreateProfileViewInput) => Promise<ProfileView>;
  messages: readonly ModelMessage[];
  profileInput: Omit<CreateProfileViewInput, "inContextMemoryRefs"> | null;
  readableMemoryRefs: (
    auth: MemoryAuthorization,
    conversationId: string,
    memoryRefs: readonly string[],
  ) => Promise<ReadonlySet<string>>;
  /** The turn's number in the show journal; `null` for a turn without a window of its own. */
  turnOrdinal: number | null;
}): Promise<TurnProfile> {
  if (input.profileInput === null) return NO_PROFILE;
  let card: { shownAtTurn: number; withdrawn: readonly string[] } | null = null;
  let inContextMemoryRefs: ReadonlySet<string> = new Set();
  if (input.turnOrdinal !== null) {
    const cards = readProfileCards(input.messages, input.turnOrdinal);
    const readable = cards.live.length === 0 ? new Set<string>()
      : await input.readableMemoryRefs(input.authorization, input.profileInput.conversationId, cards.live);
    inContextMemoryRefs = cards.fresh;
    card = {
      shownAtTurn: input.turnOrdinal,
      withdrawn: cards.live.filter((memoryRef) => !readable.has(memoryRef)),
    };
  }
  const profile = await input.createProfile(input.authorization, { ...input.profileInput, inContextMemoryRefs });
  return {
    card: card === null ? null : formatProfileCard({
      people: profile.subjects.map((subject) => ({
        facts: subject.claims, label: subject.label, personKey: profilePersonKey(subject.subjectRef),
      })),
      profileViewRef: profile.profileViewRef,
      shownAtTurn: card.shownAtTurn,
      withdrawn: card.withdrawn,
    }),
    characters: JSON.stringify(profile.subjects).length,
    claimsInContext: profile.subjects.reduce((sum, subject) => sum + (subject.claimsInContext ?? 0), 0),
    context: card === null ? formatProfileViewContext(profile) : formatProfilePeople(profile),
    memoryRefs: profile.subjects.flatMap((subject) => subject.claims.map((claim) => claim.memoryRef)),
    withdrawnClaims: card?.withdrawn.length ?? 0,
  };
}
