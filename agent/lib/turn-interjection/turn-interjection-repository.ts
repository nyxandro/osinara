/**
 * PostgreSQL access for messages shown to a running turn before their own ordinary processing.
 *
 * Exports:
 * - `TurnInterjectionCandidate`: a waiting message of the same chat queue and the same sender.
 * - `TurnInterjectionContentKind`: what the turn saw — full text, a transcript, or only a notice.
 * - `turnInterjectionRepository`: candidate listing, show-once claims, the returned and delivered
 *   states, early voice transcripts, route lookup, and the notice lookup of the ordinary turn.
 *
 * Key constructs:
 * - The ingress row is never changed except for a voice transcript, which the ordinary path reuses.
 * - A claim belongs to one tool call: a parallel call of the same step gets nothing, while a retry
 *   of that call before the model answered sees the same messages again.
 * - Only a delivered claim — a later model step of the turn had the result in its prompt — makes the
 *   later ordinary turn treat the message as already seen.
 */
import { database } from "../database.js";
import { requireNonEmpty, requireUpdateId, requireUuid } from "../telegram-ingress-contract.js";

export type TurnInterjectionContentKind = "notice" | "text" | "voice";

export interface TurnInterjectionCandidate {
  /** Messages of the same private album that arrived with this leader update. */
  albumMemberCount: number;
  payload: Record<string, unknown>;
  updateId: string;
  voice: { fileId: string; fileSize?: number; mimeType?: string } | null;
  voiceTranscript: string | null;
}

export interface TurnInterjectionShowCoordinate {
  eveSessionId: string;
  eveTurnId: string;
  toolCallId: string;
}

export type EarlyVoiceTranscription =
  | { status: "started" }
  | { status: "transcribed"; transcript: string }
  | { status: "unavailable" };

function requireCoordinate(coordinate: TurnInterjectionShowCoordinate): void {
  requireNonEmpty(coordinate.eveSessionId, "AGENT_TURN_INTERJECTION_SESSION_INVALID", "Не удалось определить сессию текущего хода");
  requireNonEmpty(coordinate.eveTurnId, "AGENT_TURN_INTERJECTION_TURN_INVALID", "Не удалось определить текущий ход");
  requireNonEmpty(coordinate.toolCallId, "AGENT_TURN_INTERJECTION_CALL_INVALID", "Не удалось определить вызов инструмента");
}

function requireApplicationSessionId(value: string): string {
  return requireUuid(value, "AGENT_TURN_INTERJECTION_CONTEXT_INVALID", "Не удалось определить текущий контекст разговора");
}

export const turnInterjectionRepository = {
  /**
   * Waiting messages after the turn's own update in the same chat queue, oldest first. Album members
   * and messages owned by another tool call or already seen by the model are excluded.
   */
  async listCandidates(input: TurnInterjectionShowCoordinate & {
    currentUpdateId: string;
    limit: number;
    telegramUserId: string;
  }): Promise<TurnInterjectionCandidate[]> {
    requireCoordinate(input);
    requireNonEmpty(input.telegramUserId, "AGENT_TURN_INTERJECTION_ACTOR_INVALID", "Не удалось определить автора текущего хода");
    const result = await database().query<{
      album_member_count: number;
      payload: Record<string, unknown>;
      update_id: string;
      voice_file_id: string | null;
      voice_file_size: string | null;
      voice_mime_type: string | null;
      voice_transcript: string | null;
    }>(
      `SELECT pending.update_id::text, pending.payload, pending.voice_transcript,
              pending.voice_file_id, pending.voice_file_size::text, pending.voice_mime_type,
              (SELECT count(*)::int FROM telegram_ingress_updates member
                WHERE member.media_group_leader_id = pending.update_id) AS album_member_count
         FROM telegram_ingress_updates current_update
         JOIN telegram_ingress_updates pending
           ON pending.queue_id = current_update.queue_id AND pending.update_id > current_update.update_id
         LEFT JOIN telegram_turn_interjections shown ON shown.update_id = pending.update_id
        WHERE current_update.update_id = $1
          AND pending.status = 'pending'
          AND pending.media_group_leader_id IS NULL
          AND pending.payload ? 'message'
          AND pending.payload->'message'->'from'->>'id' = $2
          AND (shown.update_id IS NULL OR (
            shown.eve_session_id = $3 AND shown.eve_turn_id = $4 AND shown.tool_call_id = $5
            AND shown.delivered_at IS NULL))
        ORDER BY pending.update_id
        LIMIT $6`,
      [
        requireUpdateId(input.currentUpdateId),
        input.telegramUserId,
        input.eveSessionId,
        input.eveTurnId,
        input.toolCallId,
        input.limit,
      ],
    );
    return result.rows.map((row) => ({
      albumMemberCount: row.album_member_count,
      payload: row.payload,
      updateId: row.update_id,
      voice: row.voice_file_id === null
        ? null
        : {
            fileId: row.voice_file_id,
            ...(row.voice_file_size === null ? {} : { fileSize: Number(row.voice_file_size) }),
            ...(row.voice_mime_type === null ? {} : { mimeType: row.voice_mime_type }),
          },
      voiceTranscript: row.voice_transcript,
    }));
  },

  /** Returns the update ids this tool call owns; a message shown to another call is left out. */
  async claim(
    coordinate: TurnInterjectionShowCoordinate & { applicationSessionId: string },
    messages: readonly { contentKind: TurnInterjectionContentKind; updateId: string }[],
  ): Promise<Set<string>> {
    requireCoordinate(coordinate);
    if (messages.length === 0) return new Set();
    const result = await database().query<{ update_id: string }>(
      `INSERT INTO telegram_turn_interjections
         (update_id, application_session_id, eve_session_id, eve_turn_id, tool_call_id, content_kind)
       SELECT pending.update_id, $2, $3, $4, $5, claimed.content_kind
         FROM unnest($1::bigint[], $6::text[]) AS claimed(update_id, content_kind)
         JOIN telegram_ingress_updates pending
           ON pending.update_id = claimed.update_id AND pending.status = 'pending'
       ON CONFLICT (update_id) DO UPDATE SET content_kind = EXCLUDED.content_kind, returned_at = NULL
         WHERE telegram_turn_interjections.eve_session_id = EXCLUDED.eve_session_id
           AND telegram_turn_interjections.eve_turn_id = EXCLUDED.eve_turn_id
           AND telegram_turn_interjections.tool_call_id = EXCLUDED.tool_call_id
           AND telegram_turn_interjections.delivered_at IS NULL
       RETURNING update_id::text`,
      [
        messages.map((message) => requireUpdateId(message.updateId)),
        requireApplicationSessionId(coordinate.applicationSessionId),
        coordinate.eveSessionId,
        coordinate.eveTurnId,
        coordinate.toolCallId,
        messages.map((message) => message.contentKind),
      ],
    );
    return new Set(result.rows.map((row) => row.update_id));
  },

  /** The tool result carrying these messages is about to be handed back to the turn. */
  async markReturned(coordinate: TurnInterjectionShowCoordinate, updateIds: readonly string[]): Promise<void> {
    requireCoordinate(coordinate);
    await database().query(
      `UPDATE telegram_turn_interjections SET returned_at = COALESCE(returned_at, now())
        WHERE update_id = ANY($1::bigint[]) AND eve_session_id = $2 AND eve_turn_id = $3 AND tool_call_id = $4`,
      [updateIds.map(requireUpdateId), coordinate.eveSessionId, coordinate.eveTurnId, coordinate.toolCallId],
    );
  },

  /** Frees the claims of a call whose result could not carry them, so a later call can show them. */
  async releaseCall(coordinate: TurnInterjectionShowCoordinate): Promise<void> {
    requireCoordinate(coordinate);
    await database().query(
      `DELETE FROM telegram_turn_interjections
        WHERE eve_session_id = $1 AND eve_turn_id = $2 AND tool_call_id = $3 AND delivered_at IS NULL`,
      [coordinate.eveSessionId, coordinate.eveTurnId, coordinate.toolCallId],
    );
  },

  /** A model step of this turn started after every result returned so far. */
  async markDelivered(eveSessionId: string, eveTurnId: string): Promise<number> {
    const result = await database().query(
      `UPDATE telegram_turn_interjections SET delivered_at = now()
        WHERE eve_session_id = $1 AND eve_turn_id = $2 AND returned_at IS NOT NULL AND delivered_at IS NULL`,
      [eveSessionId, eveTurnId],
    );
    return result.rowCount ?? 0;
  },

  /**
   * Marks a waiting voice message as being transcribed before the paid call, exactly like the
   * ordinary path: an interrupted call is never paid twice, the ordinary turn asks for a resend.
   */
  async beginEarlyVoiceTranscription(updateId: string): Promise<EarlyVoiceTranscription> {
    const started = await database().query(
      `UPDATE telegram_ingress_updates SET voice_transcription_started_at = now(), updated_at = now()
        WHERE update_id = $1 AND status = 'pending' AND voice_file_id IS NOT NULL
          AND voice_transcription_started_at IS NULL
        RETURNING update_id`,
      [requireUpdateId(updateId)],
    );
    if (started.rowCount === 1) return { status: "started" };
    const existing = await database().query<{ voice_transcript: string | null }>(
      "SELECT voice_transcript FROM telegram_ingress_updates WHERE update_id = $1",
      [updateId],
    );
    const transcript = existing.rows[0]?.voice_transcript;
    return transcript ? { status: "transcribed", transcript } : { status: "unavailable" };
  },

  async saveEarlyVoiceTranscript(updateId: string, transcript: string): Promise<string | null> {
    const normalized = transcript.trim();
    requireNonEmpty(normalized, "AGENT_VOICE_TRANSCRIPT_EMPTY", "В голосовом сообщении не удалось распознать речь. Запишите его ещё раз");
    const result = await database().query<{ voice_transcript: string }>(
      `UPDATE telegram_ingress_updates
          SET voice_transcript = COALESCE(voice_transcript, $2),
              voice_transcribed_at = COALESCE(voice_transcribed_at, now()), updated_at = now()
        WHERE update_id = $1 AND status = 'pending' AND voice_file_id IS NOT NULL
          AND voice_transcription_started_at IS NOT NULL
        RETURNING voice_transcript`,
      [requireUpdateId(updateId), normalized],
    );
    return result.rows[0]?.voice_transcript ?? null;
  },

  /** The live session a Telegram route currently leads to, or null when it leads nowhere. */
  async routeSessionId(baseContinuationToken: string): Promise<string | null> {
    const result = await database().query<{ session_id: string }>(
      `SELECT route.session_id::text
         FROM conversation_session_routes route
         JOIN conversation_sessions session ON session.id = route.session_id
        WHERE route.base_continuation_token = $1 AND session.retired_at IS NULL`,
      [baseContinuationToken],
    );
    return result.rows[0]?.session_id ?? null;
  },

  /**
   * A reply to a confirmation prompt, or into a conversation that awaits one, is answered by the
   * confirmation flow or refused there; it never starts an ordinary turn.
   */
  async isReplyToPendingConfirmation(input: {
    replyMessageId: string;
    replyRouteToken: string;
    telegramChatId: string;
  }): Promise<boolean> {
    const result = await database().query<{ blocked: boolean }>(
      `SELECT EXISTS (
                SELECT 1 FROM telegram_hitl_approvals
                 WHERE telegram_chat_id = $1 AND telegram_message_id = $2::bigint)
              OR EXISTS (
                SELECT 1 FROM conversation_session_routes route
                  JOIN conversation_sessions session ON session.id = route.session_id
                 WHERE route.base_continuation_token = $3 AND session.pending_operation) AS blocked`,
      [input.telegramChatId, requireUpdateId(input.replyMessageId), input.replyRouteToken],
    );
    return result.rows[0]?.blocked === true;
  },

  /** What the model saw of this message in this conversation, when it answered after seeing it. */
  async findDeliveredContentKind(
    updateId: string,
    applicationSessionId: string,
  ): Promise<TurnInterjectionContentKind | null> {
    const result = await database().query<{ content_kind: TurnInterjectionContentKind }>(
      `SELECT content_kind FROM telegram_turn_interjections
        WHERE update_id = $1 AND application_session_id = $2 AND delivered_at IS NOT NULL`,
      [requireUpdateId(updateId), requireApplicationSessionId(applicationSessionId)],
    );
    return result.rows[0]?.content_kind ?? null;
  },
};
