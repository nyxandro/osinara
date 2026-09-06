/**
 * Authorized R3 chat-local profile projection and reproducible view boundary.
 *
 * Exports:
 * - `profileViewRepository`: creates immutable selections and reads the exact authorized snapshot.
 * - Re-exported profile view contracts and formatter from `profile-view`.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { PROFILE_SELECTION_DORMANCY_MILLISECONDS } from "./memory-config.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import type { MemoryConfirmation, MemoryKind } from "./memory-record.js";
import { externalProfileProjectionPredicate } from "./external-profile-projection-predicate.js";
import {
  selectProfileClaims,
  type ProfileClaimCandidate,
  type ProfileSubjectPriority,
} from "./profile-selection.js";
import {
  toProfileView,
  type CreateProfileViewInput,
  type ProfileView,
  type ProfileViewClaim,
  type ProfileViewSubject,
} from "./profile-view.js";

export {
  formatProfileViewContext,
  type CreateProfileViewInput,
  type ProfileView,
  type ProfileViewClaim,
  type ProfileViewSubject,
} from "./profile-view.js";

interface ConversationBoundary {
  owner_user_id: string | null;
  scope: MemoryScope;
  telegram_group_id: string | null;
}

interface SubjectRow {
  id: string;
  last_verified_at: Date;
  subject_participant_id: string | null;
  subject_ref: string;
  subject_user_id: string | null;
  telegram_user_id: string;
  display_label_snapshot: string;
}

interface ClaimRow {
  claim_status: "active" | "duplicate" | "superseded";
  confirmation: MemoryConfirmation;
  content: string;
  attribute: string | null;
  evidence_kind: "firsthand" | "inferred" | "reported" | "unresolved";
  id: string;
  kind: MemoryKind;
  linked_subject_user_id: string | null;
  memory_ref: string;
  origin_label: string;
  origin_scope: MemoryScope;
  observed_at: Date;
  profile_eligible: boolean;
  sensitivity: "normal" | "sensitive";
  source_author_label: string;
  subject_participant_id: string | null;
  subject_user_id: string | null;
  updated_at: Date;
}

async function requireConversationAccess(
  client: PoolClient,
  auth: MemoryAuthorization,
  conversationId: string,
): Promise<ConversationBoundary> {
  const result = await client.query<ConversationBoundary>(
    `SELECT owner_user_id, telegram_group_id, scope
     FROM application_conversations WHERE id = $1 AND family_id = $2 FOR SHARE`,
    [conversationId, auth.familyId],
  );
  const conversation = result.rows[0];
  if (!conversation || !auth.scopes.includes(conversation.scope)) {
    throw new AppError("AGENT_PROFILE_VIEW_SCOPE_DENIED", "Профиль недоступен в текущем чате");
  }
  if (
    (conversation.scope === "personal" && (!auth.userId || conversation.owner_user_id !== auth.userId)) ||
    (conversation.scope !== "personal" && conversation.telegram_group_id !== auth.groupId)
  ) {
    throw new AppError("AGENT_PROFILE_VIEW_SCOPE_DENIED", "Профиль относится к другому чату");
  }
  if (conversation.scope !== "group") {
    const member = await client.query(
      "SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2 FOR SHARE",
      [auth.familyId, auth.userId],
    );
    if (!member.rowCount) {
      throw new AppError(
        "AGENT_PROFILE_VIEW_MEMBERSHIP_REVOKED",
        "Доступ к семейной проекции профиля был отозван",
      );
    }
  }
  return conversation;
}

function signalPriority(
  input: CreateProfileViewInput,
  resolvedReplyTelegramUserId: string | null,
): Map<string, ProfileSubjectPriority> {
  const result = new Map<string, ProfileSubjectPriority>();
  const add = (value: string, priority: ProfileSubjectPriority) => {
    if (!result.has(value)) result.set(value, priority);
  };
  if (input.suppressCurrentAuthor !== true) add(input.currentTelegramUserId, "current_author");
  if (resolvedReplyTelegramUserId) add(resolvedReplyTelegramUserId, "reply_subject");
  for (const telegramUserId of input.explicitMentionTelegramUserIds) {
    add(telegramUserId, "explicit_mention");
  }
  return result;
}

async function loadSubjects(
  client: PoolClient,
  auth: MemoryAuthorization,
  input: CreateProfileViewInput,
  conversation: ConversationBoundary,
): Promise<Array<SubjectRow & { priority: ProfileSubjectPriority }>> {
  const timelineReply = input.replyTelegramUserId === null && input.replyTimelineSequence
    ? await client.query<{ telegram_user_id: string }>(
        `SELECT telegram_user_id FROM telegram_group_messages
         WHERE conversation_id = $1 AND sequence_id = $2 AND actor_kind = 'user'
           AND telegram_user_id IS NOT NULL`,
        [input.conversationId, input.replyTimelineSequence],
      )
    : null;
  const signals = signalPriority(
    input,
    input.replyTelegramUserId ?? timelineReply?.rows[0]?.telegram_user_id ?? null,
  );
  // A suppressed current author is out of the view entirely: not by the direct pick, and not
  // through a retrieval-related claim about them, or the card returned on the very next turn.
  const suppressedTelegramUserId = input.suppressCurrentAuthor === true ? input.currentTelegramUserId : null;
  const telegramUserIds = (conversation.scope === "personal"
    ? [auth.telegramUserId]
    : [...signals.keys()]).filter((telegramUserId) => telegramUserId !== suppressedTelegramUserId);
  const dormantBefore = new Date(input.now.getTime() - PROFILE_SELECTION_DORMANCY_MILLISECONDS);
  await client.query(
    `UPDATE profile_subjects SET dormant_at = $2, updated_at = now()
     WHERE conversation_id = $1 AND last_verified_at <= $3 AND dormant_at IS NULL`,
    [input.conversationId, input.now, dormantBefore],
  );
  const result = await client.query<SubjectRow>(
    `SELECT subject.id, subject.subject_ref, subject.subject_user_id,
            subject.subject_participant_id, subject.display_label_snapshot,
            subject.last_verified_at,
            CASE WHEN subject.subject_user_id IS NOT NULL
                 THEN app_user.telegram_user_id ELSE participant.telegram_user_id END AS telegram_user_id
     FROM profile_subjects AS subject
     LEFT JOIN users AS app_user ON app_user.id = subject.subject_user_id
     LEFT JOIN conversation_participants AS participant ON participant.id = subject.subject_participant_id
     WHERE subject.conversation_id = $1
       AND (
         (CASE WHEN subject.subject_user_id IS NOT NULL
               THEN app_user.telegram_user_id ELSE participant.telegram_user_id END) = ANY($2::text[])
          OR EXISTS (
            SELECT 1
            FROM memory_items AS related_claim
            LEFT JOIN conversation_participants AS related_subject
              ON related_subject.id = related_claim.subject_participant_id
            WHERE related_claim.id = ANY($3::uuid[])
              AND (
                (subject.subject_user_id IS NOT NULL AND (
                  related_claim.subject_user_id = subject.subject_user_id OR
                  related_subject.linked_user_id = subject.subject_user_id
                )) OR
                (subject.subject_participant_id IS NOT NULL AND
                  related_claim.subject_participant_id = subject.subject_participant_id)
              )
          )
       )
       AND ($4::memory_scope <> 'family' OR EXISTS (
         SELECT 1 FROM family_memberships AS membership
         WHERE membership.family_id = $5 AND membership.user_id = subject.subject_user_id
       ))
       AND (CASE WHEN subject.subject_user_id IS NOT NULL
                 THEN app_user.telegram_user_id ELSE participant.telegram_user_id END)
           IS DISTINCT FROM $6::text
     ORDER BY subject.subject_ref`,
    [input.conversationId, telegramUserIds, input.retrievalClaimIds, conversation.scope, auth.familyId,
      suppressedTelegramUserId],
  );
  return result.rows.map((row) => ({
    ...row,
    priority: signals.get(row.telegram_user_id) ?? "retrieval_related",
  }));
}

async function loadClaims(
  client: PoolClient,
  auth: MemoryAuthorization,
  conversation: ConversationBoundary,
  subjects: readonly SubjectRow[],
): Promise<ClaimRow[]> {
  const subjectUserIds = subjects.flatMap((subject) =>
    subject.subject_user_id ? [subject.subject_user_id] : []
  );
  const subjectParticipantIds = subjects.flatMap((subject) =>
    subject.subject_participant_id ? [subject.subject_participant_id] : []
  );
  const result = await client.query<ClaimRow>(
    `SELECT claim.id, ref.memory_ref, claim.content, claim.kind, claim.attribute, claim.confirmation,
            claim.sensitivity, claim.claim_status, claim.profile_eligible, claim.updated_at,
             claim.subject_user_id, claim.subject_participant_id,
             claim_subject.linked_user_id AS linked_subject_user_id,
             origin.scope AS origin_scope, origin.label AS origin_label,
             COALESCE(evidence.evidence_kind, 'unresolved') AS evidence_kind,
             COALESCE(evidence.observed_at, claim.created_at) AS observed_at,
             COALESCE(evidence.author_label_snapshot, 'Источник не установлен') AS source_author_label
     FROM memory_items AS claim
     JOIN memory_item_refs AS ref ON ref.memory_item_id = claim.id
     JOIN application_conversations AS origin ON origin.id = claim.origin_conversation_id
     LEFT JOIN conversation_participants AS claim_subject
       ON claim_subject.id = claim.subject_participant_id
      LEFT JOIN LATERAL (
        SELECT evidence_kind, observed_at, author_label_snapshot
        FROM claim_evidence WHERE claim_id = claim.id AND evidence_role = 'primary'
        ORDER BY observed_at, id LIMIT 1
      ) AS evidence ON true
     WHERE claim.family_id = $1
       AND claim.profile_eligible = true
        AND claim.claim_status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM claim_conflicts AS conflict
          WHERE conflict.resolution = 'unresolved'
            AND claim.id IN (conflict.claim_a_id, conflict.claim_b_id)
        )
       AND claim.sensitivity = 'normal'
       AND claim.kind <> 'episode'
       AND (
         ($2::memory_scope = 'personal' AND (
           (claim.scope = 'personal' AND claim.owner_user_id = $3
             AND (claim.subject_user_id = $3 OR claim_subject.linked_user_id = $3)) OR
           (claim.scope = 'family' AND (claim.subject_user_id = $3 OR claim_subject.linked_user_id = $3)) OR
            ${externalProfileProjectionPredicate({ claimAlias: "claim", viewerUserParameter: "$3" })}
         )) OR
         ($2::memory_scope = 'family' AND claim.scope = 'family'
           AND (claim.subject_user_id = ANY($4::uuid[])
                OR claim_subject.linked_user_id = ANY($4::uuid[]))) OR
         ($2::memory_scope = 'group' AND claim.scope = 'group' AND claim.group_id = $5
           AND claim.subject_participant_id = ANY($6::uuid[]))
       )
     ORDER BY claim.id`,
    [auth.familyId, conversation.scope, auth.userId, subjectUserIds, auth.groupId,
      subjectParticipantIds],
  );
  return result.rows;
}

export const profileViewRepository = {
  async create(auth: MemoryAuthorization, input: CreateProfileViewInput): Promise<ProfileView> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const conversation = await requireConversationAccess(client, auth, input.conversationId);
      const subjects = await loadSubjects(client, auth, input, conversation);
      const claims = await loadClaims(client, auth, conversation, subjects);
      const subjectByUser = new Map(subjects.flatMap((subject) =>
        subject.subject_user_id ? [[subject.subject_user_id, subject] as const] : []
      ));
      const subjectByParticipant = new Map(subjects.flatMap((subject) =>
        subject.subject_participant_id ? [[subject.subject_participant_id, subject] as const] : []
      ));
      const candidates = claims.flatMap((claim): ProfileClaimCandidate[] => {
        const subject = conversation.scope === "group" && claim.subject_participant_id
          ? subjectByParticipant.get(claim.subject_participant_id)
          : subjectByUser.get(claim.subject_user_id ?? claim.linked_subject_user_id ?? "");
        if (!subject) return [];
        return [{
          attribute: claim.attribute,
          claimStatus: claim.claim_status,
          confirmation: claim.confirmation,
          content: claim.content,
          evidenceKind: claim.evidence_kind,
          kind: claim.kind,
          lastVerifiedAt: subject.last_verified_at.toISOString(),
          memoryRef: claim.memory_ref,
          originLabel: claim.origin_label,
          originScope: claim.origin_scope,
          observedAt: claim.observed_at.toISOString(),
          priority: subject.priority,
          profileEligible: claim.profile_eligible,
          sensitivity: claim.sensitivity,
          sourceAuthorLabel: claim.source_author_label,
          subjectLabel: subject.display_label_snapshot,
          subjectRef: subject.subject_ref,
          updatedAt: claim.updated_at.toISOString(),
        }];
      });
      const selection = selectProfileClaims(candidates, input.now);
      const selectedClaims = selection.subjects.flatMap((subject) => subject.claims);
      const insertedView = await client.query<{ created_at: Date; id: string; profile_view_ref: string }>(
         `INSERT INTO profile_views
            (family_id, viewer_conversation_id, viewer_user_id, subject_count,
             claim_count, total_characters, eve_session_id, eve_turn_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, profile_view_ref, created_at`,
        [auth.familyId, input.conversationId, auth.userId, selection.subjects.length,
          selectedClaims.length, selection.totalCharacters,
          input.provenance.sessionId, input.provenance.turnId],
      );
      const view = insertedView.rows[0]!;
      for (const [subjectOrdinal, selectedSubject] of selection.subjects.entries()) {
        const sourceSubject = subjects.find((subject) => subject.subject_ref === selectedSubject.subjectRef)!;
        await client.query(
          `INSERT INTO profile_view_subjects
             (profile_view_id, ordinal, profile_subject_id, subject_ref_snapshot,
              subject_label_snapshot, priority_reason, total_characters)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [view.id, subjectOrdinal, sourceSubject.id, selectedSubject.subjectRef,
            selectedSubject.subjectLabel, selectedSubject.priority, selectedSubject.totalCharacters],
        );
        for (const [claimOrdinal, selectedClaim] of selectedSubject.claims.entries()) {
          const sourceClaim = claims.find((claim) => claim.memory_ref === selectedClaim.memoryRef)!;
          await client.query(
            `INSERT INTO profile_view_claims
               (profile_view_id, subject_ordinal, claim_ordinal, claim_id, memory_ref_snapshot,
                 content_snapshot, kind, confirmation, origin_scope, origin_label_snapshot,
                 evidence_kind, observed_at, source_author_label_snapshot, rendered_characters,
                 attribute_snapshot)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [view.id, subjectOrdinal, claimOrdinal, sourceClaim.id, selectedClaim.memoryRef,
              selectedClaim.content, selectedClaim.kind, selectedClaim.confirmation,
              selectedClaim.originScope, selectedClaim.originLabel, selectedClaim.evidenceKind,
              selectedClaim.observedAt, selectedClaim.sourceAuthorLabel,
              selectedClaim.renderedText.length, selectedClaim.attribute],
          );
        }
      }
      await client.query("COMMIT");
      return toProfileView({ generatedAt: view.created_at, profileViewRef: view.profile_view_ref, selection });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async read(auth: MemoryAuthorization, profileViewRef: string): Promise<ProfileView> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const viewResult = await client.query<{
        claim_count: number;
        created_at: Date;
        id: string;
        total_characters: number;
        viewer_conversation_id: string;
      }>(
        `SELECT id, viewer_conversation_id, claim_count, total_characters, created_at
         FROM profile_views WHERE family_id = $1 AND profile_view_ref = $2 FOR SHARE`,
        [auth.familyId, profileViewRef],
      );
      const view = viewResult.rows[0];
      if (!view) throw new AppError("AGENT_PROFILE_VIEW_NOT_FOUND", "Снимок профиля не найден");
      const conversation = await requireConversationAccess(client, auth, view.viewer_conversation_id);
      const rows = await client.query<{
        claim_ordinal: number;
        confirmation: MemoryConfirmation;
        attribute_snapshot: string | null;
        content_snapshot: string;
        evidence_kind: ProfileViewClaim["evidenceKind"];
        kind: MemoryKind;
        memory_ref_snapshot: string;
        observed_at: Date;
        origin_label_snapshot: string;
        origin_scope: MemoryScope;
        source_author_label_snapshot: string;
        priority_reason: ProfileSubjectPriority;
        subject_label_snapshot: string;
        subject_ordinal: number;
        subject_ref_snapshot: string;
        subject_total_characters: number;
      }>(
        `SELECT subject.ordinal AS subject_ordinal, subject.subject_ref_snapshot,
                subject.subject_label_snapshot, subject.priority_reason,
                subject.total_characters AS subject_total_characters,
                selected.claim_ordinal, selected.memory_ref_snapshot,
                selected.content_snapshot, selected.kind, selected.confirmation,
                selected.origin_scope, selected.origin_label_snapshot, selected.evidence_kind,
                selected.observed_at, selected.source_author_label_snapshot,
                selected.attribute_snapshot
         FROM profile_view_subjects AS subject
         JOIN profile_view_claims AS selected ON selected.profile_view_id = subject.profile_view_id
           AND selected.subject_ordinal = subject.ordinal
         JOIN memory_items AS claim ON claim.id = selected.claim_id
         LEFT JOIN conversation_participants AS claim_subject
           ON claim_subject.id = claim.subject_participant_id
          WHERE subject.profile_view_id = $1
            AND claim.claim_status = 'active' AND claim.profile_eligible = true
            AND NOT EXISTS (
              SELECT 1 FROM claim_conflicts AS conflict
              WHERE conflict.resolution = 'unresolved'
                AND claim.id IN (conflict.claim_a_id, conflict.claim_b_id)
            )
           AND claim.sensitivity = 'normal' AND claim.kind <> 'episode'
           AND (
           ($2::memory_scope = 'personal' AND (
             (claim.scope = 'personal' AND claim.owner_user_id = $3) OR
             (claim.scope = 'family' AND (claim.subject_user_id = $3 OR claim_subject.linked_user_id = $3)) OR
              ${externalProfileProjectionPredicate({ claimAlias: "claim", viewerUserParameter: "$3" })}
           )) OR
           ($2::memory_scope = 'family' AND claim.scope = 'family') OR
           ($2::memory_scope = 'group' AND claim.scope = 'group' AND claim.group_id = $4)
         )
         ORDER BY subject.ordinal, selected.claim_ordinal`,
        [view.id, conversation.scope, auth.userId, auth.groupId],
      );
      if (rows.rows.length !== view.claim_count) {
        throw new AppError(
          "AGENT_PROFILE_VIEW_ACCESS_CHANGED",
          "Состав или доступ к этому снимку профиля изменился. Создайте новый снимок",
        );
      }
      const subjects = new Map<number, ProfileViewSubject>();
      for (const row of rows.rows) {
        const subject = subjects.get(row.subject_ordinal) ?? {
          claims: [],
          label: row.subject_label_snapshot,
          priority: row.priority_reason,
          subjectRef: row.subject_ref_snapshot,
          totalCharacters: row.subject_total_characters,
        };
        subject.claims.push({
          attribute: row.attribute_snapshot,
          confirmation: row.confirmation,
          content: row.content_snapshot,
          evidenceKind: row.evidence_kind,
          kind: row.kind,
          memoryRef: row.memory_ref_snapshot,
          observedAt: row.observed_at.toISOString(),
          origin: { label: row.origin_label_snapshot, scope: row.origin_scope },
          sourceAuthorLabel: row.source_author_label_snapshot,
        });
        subjects.set(row.subject_ordinal, subject);
      }
      await client.query("COMMIT");
      return {
        generatedAt: view.created_at.toISOString(),
        profileViewRef,
        subjects: [...subjects.values()],
        totalCharacters: view.total_characters,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
