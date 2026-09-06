/**
 * Deterministic whole-claim selection for R3 chat-local profile views.
 *
 * Exports:
 * - Profile candidate, selected claim, subject, and selection contracts.
 * - `selectProfileClaims`: applies eligibility, dormancy, subject, count, and character budgets.
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

export type ProfileSubjectPriority =
  | "current_author"
  | "explicit_mention"
  | "reply_subject"
  | "retrieval_related";

export interface ProfileClaimCandidate {
  attribute: string | null;
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
  retrieval_related: 3,
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
  const slot = candidate.attribute === null ? "" : `${candidate.attribute}: `;
  return `- [${candidate.originScope}: ${candidate.originLabel}] ${slot}${candidate.content}`;
}

function compareClaims(left: ProfileClaimCandidate, right: ProfileClaimCandidate): number {
  // Slotted claims read as a card (работа, город, …) and go before free-form ones of the same kind.
  return KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind] ||
    Number(right.attribute !== null) - Number(left.attribute !== null) ||
    (left.attribute ?? "").localeCompare(right.attribute ?? "") ||
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
  for (const [subjectRef, subjectCandidates] of orderedSubjects) {
    const priority = [...subjectCandidates]
      .sort((left, right) => SUBJECT_PRIORITY[left.priority] - SUBJECT_PRIORITY[right.priority])[0]!
      .priority;
    const deduplicated = new Map(
      [...subjectCandidates].sort(compareClaims).map((claim) => [claim.memoryRef, claim]),
    );
    const claims: SelectedProfileClaim[] = [];
    let subjectCharacters = 0;
    for (const claim of deduplicated.values()) {
      const renderedText = renderClaim(claim);
      if (
        claims.length >= PROFILE_CONTEXT_MAX_CLAIMS_PER_SUBJECT ||
        renderedText.length > PROFILE_CONTEXT_MAX_SUBJECT_CHARACTERS ||
        subjectCharacters + renderedText.length > PROFILE_CONTEXT_MAX_SUBJECT_CHARACTERS ||
        totalCharacters + renderedText.length > PROFILE_CONTEXT_MAX_CHARACTERS
      ) {
        continue;
      }
      claims.push({ ...claim, renderedText });
      subjectCharacters += renderedText.length;
      totalCharacters += renderedText.length;
    }
    if (claims.length === 0) continue;
    subjects.push({
      claims,
      priority,
      subjectLabel: subjectCandidates[0]!.subjectLabel,
      subjectRef,
      totalCharacters: subjectCharacters,
    });
  }
  return { subjects, totalCharacters };
}
