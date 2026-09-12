/** Trusted operator recovery for a completed review with missing source binding; never replays Eve. */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { advanceCompletedChain } from "./memory-review-terminal-repository.js";

const SOURCE_MISSING = "AGENT_MEMORY_REVIEW_SOURCE_BINDING_MISSING";
const OPERATOR_SKIPPED = "AGENT_MEMORY_REVIEW_OPERATOR_SKIPPED";
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

export async function inspectMemoryReviewLanes() {
  const result = await database().query<{
    laneId: string; groupTitle: string; batchId: string | null; status: string | null;
    diagnosticCode: string | null; processedThroughSequence: string; waitingSources: number;
    fromSequence: string | null; throughSequence: string | null; sourceCount: number | null;
    modelRouteKey: string | null; modelRecoveryGeneration: number | null;
    waitingSince: Date | null; lastModelSuccessAt: Date | null;
    eveSessionId: string | null; eveTurnId: string | null;
  }>(
    `SELECT lane.id AS "laneId", telegram_group.title AS "groupTitle",
            batch.id AS "batchId", batch.status::text AS status,
            batch.diagnostic_code AS "diagnosticCode",
            lane.processed_through_sequence::text AS "processedThroughSequence",
            batch.from_sequence::text AS "fromSequence", batch.through_sequence::text AS "throughSequence",
             batch.source_count AS "sourceCount",
             batch.model_route_key AS "modelRouteKey", batch.model_recovery_generation AS "modelRecoveryGeneration",
             batch.waiting_since AS "waitingSince", health.observed_at AS "lastModelSuccessAt",
             batch.eve_session_id AS "eveSessionId", batch.eve_turn_id AS "eveTurnId",
            (SELECT count(*)::integer FROM telegram_group_messages AS message
              WHERE message.conversation_id = lane.conversation_id
                AND message.message_thread_id IS NOT DISTINCT FROM lane.message_thread_id
                AND message.actor_kind IN ('user', 'telegram_bot')
                AND message.sequence_id > lane.processed_through_sequence) AS "waitingSources"
       FROM memory_review_lanes AS lane
       JOIN application_conversations AS conversation ON conversation.id = lane.conversation_id
       JOIN telegram_groups AS telegram_group ON telegram_group.id = conversation.telegram_group_id
        LEFT JOIN memory_review_batches AS batch ON batch.lane_id = lane.id
          AND batch.predecessor_sequence = lane.processed_through_sequence
        LEFT JOIN model_availability AS health ON health.route_key = batch.model_route_key
       ORDER BY lane.created_at, lane.id`,
  );
  return result.rows;
}

export async function skipUnboundMemoryReviewBatch(input: { batchId: string; reason: string }): Promise<{
  outcome: "skipped" | "replayed"; processedThroughSequence: string;
}> {
  if (!UUID_PATTERN.test(input.batchId) || !input.reason.trim()) throw new AppError(
    "AGENT_MEMORY_REVIEW_SKIP_INPUT_INVALID", "Укажите точный ID пакета и причину согласованного пропуска",
  );
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    // Same batch -> lane order as terminal handlers. Minute recovery uses SKIP LOCKED for batches.
    const locked = await client.query<{
      id: string; lane_id: string; conversation_id: string; application_session_id: string | null;
      status: string; diagnostic_code: string | null; completed_at: Date | null;
      eve_session_id: string | null; eve_turn_id: string | null;
      predecessor_sequence: string; from_sequence: string; through_sequence: string; source_count: number;
    }>(
      `SELECT id, lane_id, conversation_id, application_session_id, status::text, diagnostic_code,
              completed_at, eve_session_id, eve_turn_id, predecessor_sequence::text,
              from_sequence::text, through_sequence::text, source_count
         FROM memory_review_batches WHERE id = $1 FOR UPDATE`, [input.batchId],
    );
    const batch = locked.rows[0];
    if (!batch) throw new AppError("AGENT_MEMORY_REVIEW_SKIP_NOT_FOUND", "Пакет не найден. Повторите inspect и проверьте ID");
    const lane = await client.query<{ processed_through_sequence: string }>(
      "SELECT processed_through_sequence::text FROM memory_review_lanes WHERE id = $1 FOR UPDATE", [batch.lane_id],
    );
    if (batch.status === "skipped" && batch.diagnostic_code === OPERATOR_SKIPPED) {
      const audit = await client.query(`SELECT 1 FROM audit_events
        WHERE subject_id = $1 AND event_type = 'memory_review.operator_skipped'`, [batch.id]);
      if (audit.rowCount !== 1) throw new AppError("AGENT_MEMORY_REVIEW_SKIP_AUDIT_MISSING", "Не найдена единственная запись согласованного пропуска. Нужна проверка администратора");
      await client.query("COMMIT");
      return { outcome: "replayed", processedThroughSequence: lane.rows[0]!.processed_through_sequence };
    }
    if (batch.status !== "failed" || batch.diagnostic_code !== SOURCE_MISSING || !batch.completed_at ||
        !batch.eve_session_id || !batch.eve_turn_id ||
        lane.rows[0]!.processed_through_sequence !== batch.predecessor_sequence) throw new AppError(
      "AGENT_MEMORY_REVIEW_SKIP_STATE_INVALID",
      "Пропуск доступен только для первого завершённого с ошибкой пакета без привязки источников. Повторите inspect",
    );
    if (batch.application_session_id) {
      const session = await client.query<{ retired_at: Date | null }>(
        "SELECT retired_at FROM conversation_sessions WHERE id = $1", [batch.application_session_id],
      );
      if (session.rows[0]?.retired_at == null) throw new AppError(
        "AGENT_MEMORY_REVIEW_SKIP_SESSION_ACTIVE", "Сессия пакета ещё не закрыта. Сначала проверьте завершение её работы",
      );
    }
    const unsafe = await client.query(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM memory_turn_source_sets WHERE memory_review_batch_id = $1)
        OR EXISTS (SELECT 1 FROM memory_items_all WHERE source = $2)
        OR EXISTS (SELECT 1 FROM memory_mutation_operations WHERE eve_session_id = $3 AND eve_turn_id = $4)
        OR EXISTS (SELECT 1 FROM claim_evidence AS evidence
          WHERE evidence.origin_conversation_id = $5
            AND evidence.timeline_sequence BETWEEN $6::bigint AND $7::bigint)`,
      [batch.id, `eve:${batch.eve_session_id}:${batch.eve_turn_id}`, batch.eve_session_id, batch.eve_turn_id,
        batch.conversation_id, batch.from_sequence, batch.through_sequence],
    );
    if (unsafe.rowCount) throw new AppError(
      "AGENT_MEMORY_REVIEW_SKIP_EVIDENCE_FOUND", "Обнаружены привязанные источники или результаты записи памяти. Нужен отдельный разбор, пропуск не выполнен",
    );
    const sources = await client.query<{ count: number; first: string | null; last: string | null; valid: boolean | null }>(
      `SELECT count(*)::integer AS count, min(source.timeline_sequence)::text AS first,
              max(source.timeline_sequence)::text AS last,
              bool_and(source.conversation_id = $2 AND message.conversation_id = $2
                AND source.timeline_sequence = message.sequence_id
                AND message.actor_kind IN ('user', 'telegram_bot')
                AND message.message_thread_id IS NOT DISTINCT FROM lane.message_thread_id) AS valid
         FROM memory_review_batch_sources AS source
         JOIN telegram_group_messages AS message ON message.id = source.timeline_entry_id
         JOIN memory_review_lanes AS lane ON lane.id = $3
        WHERE source.batch_id = $1`, [batch.id, batch.conversation_id, batch.lane_id],
    );
    const retained = sources.rows[0]!;
    if (retained.count !== batch.source_count || retained.first !== batch.from_sequence ||
        retained.last !== batch.through_sequence || retained.valid !== true) throw new AppError(
      "AGENT_MEMORY_REVIEW_SKIP_SOURCES_CHANGED", "Сохранённый набор сообщений пакета изменился. Нужна проверка администратора",
    );
    await client.query(
      `UPDATE memory_review_batches SET status = 'skipped', diagnostic_code = $2,
         updated_at = now(), lease_token = NULL, lease_expires_at = NULL WHERE id = $1`,
      [batch.id, OPERATOR_SKIPPED],
    );
    await advanceCompletedChain(client, batch.lane_id);
    await client.query("DELETE FROM memory_review_batch_sources WHERE batch_id = $1", [batch.id]);
    const advanced = await client.query<{ processed_through_sequence: string }>(
      "SELECT processed_through_sequence::text FROM memory_review_lanes WHERE id = $1", [batch.lane_id],
    );
    const cursor = advanced.rows[0]!.processed_through_sequence;
    await client.query(
      `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
       SELECT family_id, 'memory_review.operator_skipped', $2,
         jsonb_build_object('reason', $3::text, 'operator', 'root-cli', 'originalDiagnosticCode', $4::text,
           'eveSessionId', $5::text, 'eveTurnId', $6::text, 'fromSequence', $7::text,
           'throughSequence', $8::text, 'sourceCount', $9::integer, 'processedThroughSequence', $10::text)
       FROM application_conversations WHERE id = $1`,
      [batch.conversation_id, batch.id, input.reason.trim(), SOURCE_MISSING, batch.eve_session_id,
        batch.eve_turn_id, batch.from_sequence, batch.through_sequence, batch.source_count, cursor],
    );
    await client.query("COMMIT");
    return { outcome: "skipped", processedThroughSequence: cursor };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
