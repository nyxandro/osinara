/**
 * Deterministic whole-claim selection for R3 chat-local profile views.
 *
 * Exports:
 * - Profile candidate, selected claim, subject, and selection contracts.
 * - `selectProfileClaims`: applies eligibility, dormancy, the repeat window, subject, count, and
 *   character budgets.
 */
import type {
  MemoryConfirmation,
  MemoryKind,
  MemorySensitivity,
} from "./memory-record.js";
import {
  PROFILE_CONTEXT_MAX_CHARACTERS,
  PROFILE_CONTEXT_MAX_CLAIMS_PER_SUBJECT,
  PROFILE_CONTEXT_MAX_SUBJECT_CHARACTERS,
  PROFILE_CONTEXT_MAX_SUBJECTS,
  PROFILE_SELECTION_DORMANCY_MILLISECONDS,
} from "./memory-config.js";

// Who a new profile view is about: the author, the person they reply to, and anyone they mention.
// A person the memory selection merely found a record about is not included (see `profile-view.ts`).
export type ProfileSubjectPriority =
  | "current_author"
  | "explicit_mention"
  | "reply_subject";

export interface ProfileClaimCandidate {
  claimStatus: "active" | "duplicate" | "superseded";
  confirmation: MemoryConfirmation;
  content: string;
  evidenceKind: "firsthand" | "inferred" | "reported" | "unresolved";
  kind: MemoryKind;
  lastVerifiedAt: string;
  memoryRef: string;
  originLabel: string;
  originScope: "family" | "group" | "personal";
  observedAt: string;
  priority: ProfileSubjectPriority;
  profileEligible: boolean;
  /** The session put it in front of the model within its repeat window; it is not shown again. */
  recentlyShown: boolean;
  sensitivity: MemorySensitivity;
  sourceAuthorLabel: string;
  subjectLabel: string;
  subjectRef: string;
  updatedAt: string;
}

export interface SelectedProfileClaim extends ProfileClaimCandidate {
  renderedText: string;
}

export interface SelectedProfileSubject {
  claims: SelectedProfileClaim[];
  /** Facts that belong in this card but were shown within the repeat window, so are left out. */
  leftOutClaims: number;
  priority: ProfileSubjectPriority;
  subjectLabel: string;
  subjectRef: string;
  totalCharacters: number;
}

export interface ProfileSelection {
  subjects: SelectedProfileSubject[];
  totalCharacters: number;
}

const SUBJECT_PRIORITY: Readonly<Record<ProfileSubjectPriority, number>> = {
  current_author: 0,
  reply_subject: 1,
  explicit_mention: 2,
};
const KIND_PRIORITY: Readonly<Record<MemoryKind, number>> = {
  profile: 0,
  preference: 1,
  fact: 2,
  family_shared: 3,
  episode: 4,
};
const ORIGIN_PRIORITY = { personal: 0, family: 1, group: 2 } as const;

function isDormant(lastVerifiedAt: string, now: Date): boolean {
  const observed = new Date(lastVerifiedAt).getTime();
  return !Number.isFinite(observed) || now.getTime() - observed >= PROFILE_SELECTION_DORMANCY_MILLISECONDS;
}

function renderClaim(candidate: ProfileClaimCandidate): string {
  return `- [${candidate.originScope}: ${candidate.originLabel}] ${candidate.content}`;
}

function compareClaims(left: ProfileClaimCandidate, right: ProfileClaimCandidate): number {
  return KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind] ||
    Number(right.confirmation === "user_confirmed") - Number(left.confirmation === "user_confirmed") ||
    ORIGIN_PRIORITY[left.originScope] - ORIGIN_PRIORITY[right.originScope] ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.memoryRef.localeCompare(right.memoryRef);
}

export function selectProfileClaims(
  candidates: readonly ProfileClaimCandidate[],
  now: Date,
): ProfileSelection {
  // Eligibility is enforced again after SQL authorization so always-on context cannot accidentally
  // admit sensitive, episodic, stale-lifecycle, or unverified-subject records.
  const eligible = candidates.filter((candidate) =>
    candidate.profileEligible &&
    candidate.claimStatus === "active" &&
    candidate.sensitivity === "normal" &&
    candidate.kind !== "episode" &&
    !isDormant(candidate.lastVerifiedAt, now)
  );
  const bySubject = new Map<string, ProfileClaimCandidate[]>();
  for (const candidate of eligible) {
    const subject = bySubject.get(candidate.subjectRef) ?? [];
    subject.push(candidate);
    bySubject.set(candidate.subjectRef, subject);
  }

  // Subject priority is the strongest verified signal, with opaque ref as a stable final tie-break.
  const orderedSubjects = [...bySubject.entries()].sort(([leftRef, left], [rightRef, right]) => {
    const leftPriority = Math.min(...left.map((item) => SUBJECT_PRIORITY[item.priority]));
    const rightPriority = Math.min(...right.map((item) => SUBJECT_PRIORITY[item.priority]));
    return leftPriority - rightPriority || leftRef.localeCompare(rightRef);
  }).slice(0, PROFILE_CONTEXT_MAX_SUBJECTS);

  const subjects: SelectedProfileSubject[] = [];
  let totalCharacters = 0;
  // The budget is spent on the whole card, recently shown facts included, and only then are those
  // left out. Spent on what is shown, every freed place went to the next fact in line, and a large
  // profile paged through itself thirty facts a turn.
  let cardCharacters = 0;
  for (const [subjectRef, subjectCandidates] of orderedSubjects) {
    const priority = [...subjectCandidates]
      .sort((left, right) => SUBJECT_PRIORITY[left.priority] - SUBJECT_PRIORITY[right.priority])[0]!
      .priority;
    const deduplicated = new Map(
      [...subjectCandidates].sort(compareClaims).map((claim) => [claim.memoryRef, claim]),
    );
    const claims: SelectedProfileClaim[] = [];
    let subjectCharacters = 0;
    let cardClaims = 0;
    let cardSubjectCharacters = 0;
    let leftOutClaims = 0;
    for (const claim of deduplicated.values()) {
      const renderedText = renderClaim(claim);
      if (
        cardClaims >= PROFILE_CONTEXT_MAX_CLAIMS_PER_SUBJECT ||
        renderedText.length > PROFILE_CONTEXT_MAX_SUBJECT_CHARACTERS ||
        cardSubjectCharacters + renderedText.length > PROFILE_CONTEXT_MAX_SUBJECT_CHARACTERS ||
        cardCharacters + renderedText.length > PROFILE_CONTEXT_MAX_CHARACTERS
      ) {
        continue;
      }
      cardClaims += 1;
      cardSubjectCharacters += renderedText.length;
      cardCharacters += renderedText.length;
      if (claim.recentlyShown) {
        leftOutClaims += 1;
        continue;
      }
      claims.push({ ...claim, renderedText });
      subjectCharacters += renderedText.length;
      totalCharacters += renderedText.length;
    }
    // A person whose facts were all just shown stays without them: their ref is the only way this
    // turn can link a new fact to them, and leaving them out would make it a bare text label.
    if (claims.length === 0 && leftOutClaims === 0) continue;
    subjects.push({
      claims,
      leftOutClaims,
      priority,
      subjectLabel: subjectCandidates[0]!.subjectLabel,
      subjectRef,
      totalCharacters: subjectCharacters,
    });
  }
  return { subjects, totalCharacters };
}
