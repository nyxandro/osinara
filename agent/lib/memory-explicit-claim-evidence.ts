/**
 * Explicit Telegram-source preparation for the single memory claim writer.
 *
 * Export:
 * - `prepareExplicitClaimEvidence`: resolves current message, author, scope, and optional subject ref.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import type { PreparedClaimEvidence } from "./claim-evidence-writer.js";
import { MEMORY_EVIDENCE_SNIPPET_MAX_CHARACTERS } from "./memory-config.js";
import { requireAllowedMemoryContent } from "./memory-content-policy.js";
import type { MemoryAuthorization } from "./memory-context.js";
import type { CreateMemoryInput } from "./memory-record.js";
import { normalizeMemoryClaimContent } from "./memory-record.js";

interface ExplicitTimelineSourceRow {
  author_label: string | null;
  author_participant_id: string;
  author_user_id: string | null;
  content_text: string | null;
  conversation_label: string;
  family_id: string;
  message_thread_id: string | null;
  scope: "family" | "group" | "personal";
  scope_partition_key: string;
  sent_at: Date;
  telegram_group_id: string | null;
  telegram_user_id: string;
  telegram_message_id: string;
  timeline_sequence: string;
}

function evidenceSnippet(content: string): string {
  const bounded = [...content.trim()].slice(0, MEMORY_EVIDENCE_SNIPPET_MAX_CHARACTERS).join("");
  if (!bounded) {
    throw new AppError(
      "AGENT_MEMORY_EVIDENCE_SOURCE_EMPTY",
      "Текущее сообщение не содержит текста для проверяемого источника памяти",
    );
  }
  return bounded;
}

export async function prepareExplicitClaimEvidence(
  client: PoolClient,
  auth: MemoryAuthorization,
  input: CreateMemoryInput,
): Promise<PreparedClaimEvidence> {
  const source = input.explicitSource;
  if (!source) {
    throw new AppError(
      "AGENT_MEMORY_EXPLICIT_SOURCE_INVALID",
      "Явное сохранение требует одного проверенного источника и явного subject intent",
    );
  }
  if (source.subject.kind === "label" &&
    (!source.subject.label.trim() || source.subject.label.length > 200)) {
    throw new AppError(
      "AGENT_MEMORY_SUBJECT_LABEL_INVALID",
      "Текстовая метка субъекта памяти должна содержать от 1 до 200 символов",
    );
  }
  const result = await client.query<ExplicitTimelineSourceRow>(
    `SELECT conversation.family_id, conversation.scope, conversation.scope_partition_key,
            conversation.telegram_group_id, conversation.label AS conversation_label,
            message.content_text, message.sent_at, message.sequence_id AS timeline_sequence,
            message.telegram_message_id::text, message.message_thread_id,
            message.telegram_user_id, participant.id AS author_participant_id,
            participant.linked_user_id AS author_user_id,
            participant.display_name_snapshot AS author_label
     FROM telegram_group_messages AS message
     JOIN application_conversations AS conversation ON conversation.id = message.conversation_id
     JOIN conversation_participants AS participant
       ON participant.conversation_id = conversation.id
       AND participant.telegram_user_id = message.telegram_user_id
      WHERE message.id = $1 AND message.conversation_id = $2
        AND message.actor_kind IN ('user', 'telegram_bot')
        AND (
          conversation.scope = 'group' OR message.actor_kind = 'telegram_bot' OR EXISTS (
            SELECT 1 FROM family_memberships AS membership
            WHERE membership.family_id = conversation.family_id
              AND membership.user_id = participant.linked_user_id
          )
        )
        AND (
           -- The invoking actor may be a person or another bot; both are journaled by their
           -- Telegram id, and the turn's source set was bound to that exact actor.
           message.telegram_user_id = $3 OR EXISTS (
            SELECT 1
            FROM memory_turn_sources AS turn_source
            JOIN memory_turn_source_sets AS source_set
              ON source_set.eve_session_id = turn_source.eve_session_id
             AND source_set.eve_turn_id = turn_source.eve_turn_id
            WHERE turn_source.timeline_entry_id = message.id
              AND turn_source.conversation_id = message.conversation_id
              AND source_set.eve_session_id = $4
              AND source_set.eve_turn_id = $5
               AND source_set.invoking_actor_kind = $6::text
               AND source_set.invoking_actor_id = $3
           ) OR EXISTS (
             SELECT 1
             FROM memory_turn_sources AS turn_source
             JOIN memory_turn_source_sets AS source_set
               ON source_set.eve_session_id = turn_source.eve_session_id
              AND source_set.eve_turn_id = turn_source.eve_turn_id
             WHERE turn_source.timeline_entry_id = message.id
               AND turn_source.conversation_id = message.conversation_id
               AND source_set.eve_session_id = $4
               AND source_set.eve_turn_id = $5
               AND source_set.memory_review_batch_id IS NOT NULL
           )
        )`,
    [source.timelineEntryId, source.conversationId,
      auth.telegramActorKind === "telegram_channel" ? null : auth.telegramActorId,
      input.provenance?.sessionId ?? null, input.provenance?.turnId ?? null,
      auth.telegramActorKind === "telegram_channel" ? null : auth.telegramActorKind],
  );
  const row = result.rows[0];
  const expectedPartition = input.scope === "group"
    ? auth.groupId
    : input.scope === "personal"
      ? auth.userId
      : auth.familyId;
  if (!row || row.family_id !== auth.familyId || row.scope !== input.scope ||
    row.scope_partition_key !== expectedPartition || !row.content_text) {
    throw new AppError(
      "AGENT_MEMORY_EXPLICIT_SOURCE_INVALID",
      "Текущее проверенное сообщение не относится к выбранной области памяти",
    );
  }
  requireAllowedMemoryContent(row.content_text);

  // Subject identity is explicit: author, current-turn verified ref, label-only, or none.
  let subjectParticipantId: string | null = null;
  let subjectConversationId: string | null = null;
  let subjectUserId: string | null = null;
  if (source.subject.kind === "current_author") {
    if (input.scope === "group") {
      subjectParticipantId = row.author_participant_id;
      subjectConversationId = source.conversationId;
    } else {
      const invalidAuthor = !row.author_user_id ||
        (input.scope === "personal" && row.author_user_id !== auth.userId);
      if (invalidAuthor) {
        throw new AppError(
          "AGENT_MEMORY_SUBJECT_CURRENT_AUTHOR_INVALID",
          "Не удалось подтвердить identity автора выбранного сообщения. Повторите запрос после обновления чата",
        );
      }
      subjectUserId = row.author_user_id;
    }
  }
  if (source.subject.kind === "verified_ref") {
    if (!input.provenance) {
      throw new AppError(
        "AGENT_MEMORY_SUBJECT_REF_TURN_INVALID",
        "Для другого субъекта отсутствует проверенный контекст текущего хода",
      );
    }
    const subjectResult = await client.query<{
      subject_participant_id: string | null;
      subject_user_id: string | null;
    }>(
      `SELECT subject.subject_participant_id, subject.subject_user_id
         FROM profile_views AS view
         JOIN profile_view_subjects AS selected ON selected.profile_view_id = view.id
         JOIN profile_subjects AS subject ON subject.id = selected.profile_subject_id
        WHERE selected.subject_ref_snapshot = $1 AND subject.subject_ref = $1
           AND view.viewer_conversation_id = $2 AND view.family_id = $3
          AND view.eve_session_id = $4 AND view.eve_turn_id = $5
          AND view.viewer_user_id IS NOT DISTINCT FROM $6`,
      [source.subject.subjectRef, source.conversationId, auth.familyId,
        input.provenance.sessionId, input.provenance.turnId, auth.userId],
    );
    const subject = subjectResult.rows[0];
    const validIdentity = input.scope === "group"
      ? subject?.subject_participant_id !== null && subject?.subject_user_id === null
      : subject?.subject_user_id !== null && subject?.subject_participant_id === null;
    if (!subject || !validIdentity) {
      throw new AppError(
        "AGENT_MEMORY_SUBJECT_REF_INVALID",
        "Ссылка на субъект недоступна в текущем ходе. Используйте subjectRef из текущего профиля",
      );
    }
    subjectParticipantId = subject.subject_participant_id;
    subjectConversationId = subjectParticipantId === null ? null : source.conversationId;
    subjectUserId = subject.subject_user_id;
  }
  const evidenceKind = (subjectParticipantId !== null &&
    subjectParticipantId !== row.author_participant_id) ||
    (subjectUserId !== null && subjectUserId !== row.author_user_id)
    ? "reported"
    : "firsthand";

  return {
    auditActorUserId: auth.userId,
    contentNormalized: normalizeMemoryClaimContent(input.content),
    conversationId: source.conversationId,
    conversationLabelSnapshot: row.conversation_label,
    evidenceKind,
    familyId: auth.familyId,
    primaryAuthorTelegramUserId: row.telegram_user_id,
    primaryAuthorUserId: row.author_user_id,
    scope: input.scope,
    scopePartitionKey: row.scope_partition_key,
    sources: [{
      authorLabelSnapshot: row.author_label,
      authorParticipantId: row.author_participant_id,
      authorTelegramUserId: row.telegram_user_id,
      authorUserId: row.author_user_id,
      evidenceSnippet: evidenceSnippet(row.content_text),
      messageThreadId: row.message_thread_id,
      observedAt: row.sent_at,
      role: "primary",
      sourceMessageId: row.telegram_message_id,
      sourceSnapshot: { content: row.content_text },
      timelineEntryId: source.timelineEntryId,
      timelineSequence: row.timeline_sequence,
    }],
    subjectConversationId,
    subjectKind: source.subject.kind,
    subjectLabel: source.subject.kind === "label" ? source.subject.label : null,
    subjectParticipantId,
    subjectUserId,
    telegramGroupId: row.telegram_group_id,
  };
}
