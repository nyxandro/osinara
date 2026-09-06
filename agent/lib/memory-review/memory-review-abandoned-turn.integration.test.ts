/**
 * PostgreSQL integration tests for abandoned memory-review turns.
 *
 * Constructs covered:
 * - The durable turn binding survives a pause for a human answer and closes the batch afterwards.
 * - A turn that never reports back is released, skipped, or counted strictly by provenance.
 * - A live turn, parked or merely slow, is never touched by the watchdog.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createMainAgentMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { memoryTurnSourceRepository } from "../memory-turn-source-repository.js";
import { memoryReviewRepository } from "./memory-review-repository.js";
import { memoryReviewDispatchRepository } from "./memory-review-dispatch-repository.js";
import {
  insertReviewSession,
  insertReviewUserMessage,
} from "./memory-review.integration-fixtures.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

/** Eight passive messages: the shortest tail an addressed turn still reviews inline here. */
async function insertReviewTail(
  fixture: { conversationId: string; groupId: string },
  from: number,
): Promise<{ id: string }> {
  let last: { id: string } | null = null;
  for (let sequence = from; sequence < from + 8; sequence += 1) {
    last = await insertReviewUserMessage({
      conversationId: fixture.conversationId, groupId: fixture.groupId, sequence,
    });
  }
  return last!;
}

describeWithDatabase("abandoned memory review turns", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);
  it("finds the review batch of a resumed turn whose context lost the marker", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const session = await insertReviewSession(fixture.familyId, fixture.groupId, "review-resumed");
    const source = await insertReviewTail(fixture, 2);
    const batch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session,
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: session,
      batchId: batch!.batchId,
      eveSessionId: "eve-resumed",
      eveTurnId: "turn-resumed",
    });

    // Ход, продолженный после ответа человека, приходит с авторизацией этого ответа, поэтому
    // метка пакета в ней отсутствует. Привязка хода к пакету живёт в базе и переживает паузу.
    await expect(memoryReviewRepository.batchIdForTurn({
      eveSessionId: "eve-resumed",
      eveTurnId: "turn-resumed",
    })).resolves.toBe(batch!.batchId);

    await memoryReviewRepository.completeBatch({
      batchId: batch!.batchId,
      completedAt: new Date(),
      eveSessionId: "eve-resumed",
      eveTurnId: "turn-resumed",
    });

    // Ход остаётся ходом проверки и после закрытия пакета, иначе повторное событие Eve засчиталось
    // бы как обычный ход разговора и закрыло бы сессию.
    await expect(memoryReviewRepository.batchIdForTurn({
      eveSessionId: "eve-resumed",
      eveTurnId: "turn-resumed",
    })).resolves.toBe(batch!.batchId);
    await expect(memoryReviewRepository.batchIdForTurn({
      eveSessionId: "eve-resumed",
      eveTurnId: "turn-other",
    })).resolves.toBeNull();
  });

  it("releases a running batch whose session no longer waits for an answer", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const session = await insertReviewSession(fixture.familyId, fixture.groupId, "review-abandoned");
    const source = await insertReviewTail(fixture, 2);
    const batch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session,
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: session,
      batchId: batch!.batchId,
      eveSessionId: "eve-abandoned",
      eveTurnId: "turn-abandoned",
    });
    await database().query(
      "UPDATE memory_review_batches SET started_at = '2026-08-12T09:00:00.000Z' WHERE id = $1",
      [batch!.batchId],
    );

    await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-08-12T11:00:00.000Z"),
    });

    // Ход ничего не записал, поэтому пакет освобождён целиком: источники возвращаются в
    // непроверенный хвост, и следующий обычный ход разбирает их заново.
    await expect(database().query(
      "SELECT count(*)::integer AS batches FROM memory_review_batches WHERE id = $1",
      [batch!.batchId],
    )).resolves.toMatchObject({ rows: [{ batches: 0 }] });
    const repeated = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session,
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
    expect(repeated?.sourceCount).toBe(9);
  });

  it("resolves an ambiguous head at the cursor by provenance after the time bound", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const session = await insertReviewSession(fixture.familyId, fixture.groupId, "review-ambiguous-head");
    const source = await insertReviewTail(fixture, 2);
    const batch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session,
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: session,
      batchId: batch!.batchId,
      eveSessionId: "eve-ambiguous",
      eveTurnId: "turn-ambiguous",
    });
    // A session failure or a handoff timeout still ends this way; the lane cursor cannot pass it.
    await database().query(
      `UPDATE memory_review_batches
          SET status = 'ambiguous', diagnostic_code = 'AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS',
              completed_at = '2026-08-12T09:00:00.000Z', updated_at = '2026-08-12T09:00:00.000Z'
        WHERE id = $1`,
      [batch!.batchId],
    );
    await expect(memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session, groupId: fixture.groupId, timelineEntryId: source.id,
    })).resolves.toBeNull();

    // Ten minutes later the head is still fresh and still blocks the lane.
    await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 10, now: new Date("2026-08-12T09:10:00.000Z"),
    });
    await expect(database().query(
      "SELECT status::text FROM memory_review_batches WHERE id = $1", [batch!.batchId],
    )).resolves.toMatchObject({ rows: [{ status: "ambiguous" }] });

    // Past the bound it wrote nothing and nothing stands behind it: released to the tail.
    await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 10, now: new Date("2026-08-12T11:00:00.000Z"),
    });
    await expect(database().query(
      "SELECT count(*)::integer AS batches FROM memory_review_batches WHERE id = $1", [batch!.batchId],
    )).resolves.toMatchObject({ rows: [{ batches: 0 }] });
    const repeated = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session, groupId: fixture.groupId, timelineEntryId: source.id,
    });
    expect(repeated?.sourceCount).toBe(9);
  });

  it("skips a failed head at the cursor that already has a completed successor", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const session = await insertReviewSession(fixture.familyId, fixture.groupId, "review-failed-head");
    const head = await insertReviewTail(fixture, 2);
    const failed = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session, groupId: fixture.groupId, timelineEntryId: head.id,
    });
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: session, batchId: failed!.batchId, eveSessionId: "eve-failed-head", eveTurnId: "turn-failed-head",
    });
    const successorSource = await insertReviewTail(fixture, 10);
    const successor = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session, groupId: fixture.groupId, timelineEntryId: successorSource.id,
    });
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: session, batchId: successor!.batchId, eveSessionId: "eve-successor", eveTurnId: "turn-successor",
    });
    await database().query(
      `UPDATE memory_review_batches
          SET status = CASE WHEN id = $1 THEN 'failed'::memory_review_batch_status ELSE 'completed'::memory_review_batch_status END,
              diagnostic_code = CASE WHEN id = $1 THEN 'AGENT_MEMORY_REVIEW_MODEL_FAILED' ELSE NULL END,
              completed_at = '2026-08-12T09:00:00.000Z', updated_at = '2026-08-12T09:00:00.000Z'
        WHERE id IN ($1, $2)`,
      [failed!.batchId, successor!.batchId],
    );

    await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 10, now: new Date("2026-08-12T11:00:00.000Z"),
    });

    await expect(database().query(
      `SELECT batch.status::text, lane.processed_through_sequence::text AS cursor
         FROM memory_review_batches AS batch JOIN memory_review_lanes AS lane ON lane.id = batch.lane_id
        WHERE batch.id = $1`,
      [failed!.batchId],
    )).resolves.toMatchObject({ rows: [{ cursor: "17", status: "skipped" }] });
    await expect(database().query(
      "SELECT batch_diagnostic_code FROM memory_review_owner_alerts WHERE batch_id = $1", [failed!.batchId],
    )).resolves.toMatchObject({ rows: [{ batch_diagnostic_code: "AGENT_MEMORY_REVIEW_PASS_SKIPPED" }] });
  });

  it("keeps a running batch whose turn is still parked on a human answer", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const session = await insertReviewSession(fixture.familyId, fixture.groupId, "review-parked");
    const source = await insertReviewTail(fixture, 2);
    const batch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session,
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: session,
      batchId: batch!.batchId,
      eveSessionId: "eve-parked",
      eveTurnId: "turn-parked",
    });
    await database().query(
      "UPDATE memory_review_batches SET started_at = '2026-08-12T09:00:00.000Z' WHERE id = $1",
      [batch!.batchId],
    );
    // Парковка на вопросе переводит групповую сессию в задачу: каноническая групповая сессия
    // не может быть ожидающей. Такой ход жив, и трогать его пакет нельзя.
    await database().query(
      `UPDATE conversation_sessions
          SET kind = 'task', task_state = 'pending', pending_operation = true
        WHERE id = $1`,
      [session],
    );

    await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-08-12T11:00:00.000Z"),
    });

    await expect(database().query(
      "SELECT status::text FROM memory_review_batches WHERE id = $1",
      [batch!.batchId],
    )).resolves.toMatchObject({ rows: [{ status: "running" }] });
  });

  it("counts an abandoned turn that already wrote memory as reviewed", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const session = await insertReviewSession(fixture.familyId, fixture.groupId, "review-partial");
    const source = await insertReviewTail(fixture, 2);
    const batch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session,
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: session,
      batchId: batch!.batchId,
      eveSessionId: "eve-partial",
      eveTurnId: "turn-partial",
    });
    await database().query(
      `INSERT INTO memory_items_all
         (family_id, scope, kind, confirmation, sensitivity, content, source, operation_key)
       VALUES ($1, 'family', 'fact', 'model_high', 'normal', 'Записано до обрыва', $2, $3)`,
      [fixture.familyId, "eve:eve-partial:turn-partial", "op-review-partial"],
    );
    await database().query(
      "UPDATE memory_review_batches SET started_at = '2026-08-12T09:00:00.000Z' WHERE id = $1",
      [batch!.batchId],
    );

    await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-08-12T11:00:00.000Z"),
    });

    // Повтор такого хода создал бы дубликаты, поэтому проверка засчитывается и курсор идёт дальше.
    await expect(database().query(
      "SELECT status::text FROM memory_review_batches WHERE id = $1",
      [batch!.batchId],
    )).resolves.toMatchObject({ rows: [{ status: "completed" }] });
    await expect(database().query(
      `SELECT lane.processed_through_sequence::text AS cursor
         FROM memory_review_lanes AS lane
         JOIN memory_review_batches AS batch ON batch.lane_id = lane.id
        WHERE batch.id = $1`,
      [batch!.batchId],
    )).resolves.toMatchObject({ rows: [{ cursor: "9" }] });
  });

  it("releases a running batch whose application session is already gone", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "1",
    });
    let created = null;
    for (let sequence = 2; sequence <= 51; sequence += 1) {
      const message = await insertReviewUserMessage({
        conversationId: fixture.conversationId,
        groupId: fixture.groupId,
        sequence,
      });
      created = await memoryReviewRepository.observePassiveMessage({
        groupId: fixture.groupId,
        timelineEntryId: message.id,
      });
    }
    // Session retention nulls the batch's session reference, and only a background batch may
    // outlive it: the interactive check constraint forbids that combination outright.
    await database().query(
      `UPDATE memory_review_batches
          SET status = 'running', eve_session_id = 'eve-orphan', eve_turn_id = 'turn-orphan',
              application_session_id = NULL, started_at = '2026-08-12T09:00:00.000Z'
        WHERE id = $1`,
      [created!.batchId],
    );

    await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-08-12T11:00:00.000Z"),
    });

    // Без сессии ждать нечего: ход умер вместе с ней, и место на курсоре нужно освободить.
    await expect(database().query(
      "SELECT count(*)::integer AS batches FROM memory_review_batches WHERE id = $1",
      [created!.batchId],
    )).resolves.toMatchObject({ rows: [{ batches: 0 }] });
  });

  it("skips an abandoned head that already has successors instead of deleting it", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const session = await insertReviewSession(fixture.familyId, fixture.groupId, "review-head");
    const head = await insertReviewTail(fixture, 2);
    const abandoned = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session,
      groupId: fixture.groupId,
      timelineEntryId: head.id,
    });
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: session,
      batchId: abandoned!.batchId,
      eveSessionId: "eve-head",
      eveTurnId: "turn-head",
    });
    // Пока голова висит, обычные ходы продолжают создавать пакеты за ней: они цепляются за её
    // конец, а не за курсор лейна. Именно так лейн и накапливает наследников.
    const successorSource = await insertReviewTail(fixture, 10);
    const successor = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session,
      groupId: fixture.groupId,
      timelineEntryId: successorSource.id,
    });
    expect(successor?.batchId).not.toBe(abandoned!.batchId);
    await database().query(
      "UPDATE memory_review_batches SET started_at = '2026-08-12T09:00:00.000Z' WHERE id = $1",
      [abandoned!.batchId],
    );

    await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-08-12T11:00:00.000Z"),
    });

    // Удаление головы оставило бы наследника недостижимым от курсора. Пакет остаётся строкой в
    // терминальном состоянии, курсор проходит через него, а источники отпускаются.
    await expect(database().query(
      `SELECT batch.status::text, batch.diagnostic_code, batch.completed_at IS NOT NULL AS closed,
              lane.processed_through_sequence::text AS cursor,
              (SELECT count(*)::integer FROM memory_review_batch_sources AS source
                WHERE source.batch_id = batch.id) AS sources
         FROM memory_review_batches AS batch
         JOIN memory_review_lanes AS lane ON lane.id = batch.lane_id
        WHERE batch.id = $1`,
      [abandoned!.batchId],
    )).resolves.toMatchObject({
      rows: [{
        closed: true,
        cursor: "9",
        diagnostic_code: "AGENT_MEMORY_REVIEW_TURN_ABANDONED",
        sources: 0,
        status: "skipped",
      }],
    });
    // Наследник цел и по-прежнему достижим от сдвинувшегося курсора.
    await expect(database().query(
      "SELECT predecessor_sequence::text AS predecessor FROM memory_review_batches WHERE id = $1",
      [successor!.batchId],
    )).resolves.toMatchObject({ rows: [{ predecessor: "9" }] });
    // Владелец узнаёт о безвозвратно пропущенных сообщениях.
    await expect(database().query(
      "SELECT batch_diagnostic_code FROM memory_review_owner_alerts WHERE batch_id = $1",
      [abandoned!.batchId],
    )).resolves.toMatchObject({
      rows: [{ batch_diagnostic_code: "AGENT_MEMORY_REVIEW_PASS_SKIPPED" }],
    });
  });

  it("leaves a running batch alone before the abandon timeout elapses", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const session = await insertReviewSession(fixture.familyId, fixture.groupId, "review-fresh");
    const source = await insertReviewTail(fixture, 2);
    const batch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session,
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: session,
      batchId: batch!.batchId,
      eveSessionId: "eve-fresh",
      eveTurnId: "turn-fresh",
    });
    await database().query(
      "UPDATE memory_review_batches SET started_at = '2026-08-12T10:50:00.000Z' WHERE id = $1",
      [batch!.batchId],
    );

    // Ход идёт десять минут: обычная длительность прохода, трогать его нельзя.
    await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-08-12T11:00:00.000Z"),
    });

    await expect(database().query(
      "SELECT status::text FROM memory_review_batches WHERE id = $1",
      [batch!.batchId],
    )).resolves.toMatchObject({ rows: [{ status: "running" }] });
  });

  it("releases a background batch that died before binding its turn", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "1",
    });
    let created = null;
    for (let sequence = 2; sequence <= 51; sequence += 1) {
      const message = await insertReviewUserMessage({
        conversationId: fixture.conversationId,
        groupId: fixture.groupId,
        sequence,
      });
      created = await memoryReviewRepository.observePassiveMessage({
        groupId: fixture.groupId,
        timelineEntryId: message.id,
      });
    }
    const proactive = (await database().query<{ id: string }>(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, group_id, scope, kind, task_state, conversation_key,
          continuation_token, started_at, last_activity_at, memory_review_batch_id)
       VALUES (gen_random_uuid(), 0, $1, $2, 'family', 'proactive', 'running', 'review-unbound',
               'review-unbound', now(), now(), $3) RETURNING id`,
      [fixture.familyId, fixture.groupId, created!.batchId],
    )).rows[0]!.id;
    // `markRunning` записывает сессию Eve, а номер хода приходит только из `turn.started`. Между
    // этими шагами память записать невозможно, поэтому такой пакет освобождается без сомнений.
    await database().query(
      `UPDATE memory_review_batches
          SET status = 'running', eve_session_id = 'eve-unbound', eve_turn_id = NULL,
              application_session_id = $2, started_at = '2026-08-12T09:00:00.000Z'
        WHERE id = $1`,
      [created!.batchId, proactive],
    );

    await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-08-12T11:00:00.000Z"),
    });

    await expect(database().query(
      "SELECT count(*)::integer AS batches FROM memory_review_batches WHERE id = $1",
      [created!.batchId],
    )).resolves.toMatchObject({ rows: [{ batches: 0 }] });
    // Сессия фоновой проверки не закрывается ничем другим: ни уборкой задач, ни ретенцией.
    await expect(database().query(
      "SELECT retired_at IS NOT NULL AS retired, task_state::text FROM conversation_sessions WHERE id = $1",
      [proactive],
    )).resolves.toMatchObject({ rows: [{ retired: true, task_state: "failed" }] });
  });

  it("accepts a repeated completion event after the batch was released", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const session = await insertReviewSession(fixture.familyId, fixture.groupId, "review-replay");
    const source = await insertReviewTail(fixture, 2);
    const batch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session,
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: session,
      batchId: batch!.batchId,
      eveSessionId: "eve-replay",
      eveTurnId: "turn-replay",
    });
    await expect(memoryReviewRepository.failRunning({
      batchId: batch!.batchId,
      diagnosticCode: "AGENT_MEMORY_REVIEW_MODEL_FAILED",
      eveSessionId: "eve-replay",
      eveTurnId: "turn-replay",
    })).resolves.toBe("released");

    // Событие Eve может прийти повторно. Строки уже нет, и это тот же исход, а не конфликт.
    await expect(memoryReviewRepository.completeBatch({
      batchId: batch!.batchId,
      completedAt: new Date(),
      eveSessionId: "eve-replay",
      eveTurnId: "turn-replay",
    })).resolves.toBe("replayed");
  });

  it("skips a never-started head that already has successors", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const session = await insertReviewSession(fixture.familyId, fixture.groupId, "review-unstarted");
    const head = await insertReviewTail(fixture, 2);
    const abandoned = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session,
      groupId: fixture.groupId,
      timelineEntryId: head.id,
    });
    // Отмена следующим сообщением приходит раньше `turn.started`, поэтому привязки к ходу нет.
    const successorSource = await insertReviewTail(fixture, 10);
    const successor = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session,
      groupId: fixture.groupId,
      timelineEntryId: successorSource.id,
    });
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: session,
      batchId: successor!.batchId,
      eveSessionId: "eve-unstarted-successor",
      eveTurnId: "turn-unstarted-successor",
    });
    await memoryTurnSourceRepository.bind({
      applicationSessionId: session,
      conversationId: fixture.conversationId,
      currentTimelineEntryId: successorSource.id,
      eveSessionId: "eve-unstarted-successor",
      eveTurnId: "turn-unstarted-successor",
      invokingActorId: "agent-memory-author",
      invokingActorKind: "telegram_user",
      memoryReviewBatchId: successor!.batchId,
      memoryReviewSourceEntryIds: successor!.sourceEntryIds,
      visibleTimelineEntryIds: [successorSource.id],
    });
    await memoryReviewRepository.completeBatch({
      batchId: successor!.batchId,
      completedAt: new Date(),
      eveSessionId: "eve-unstarted-successor",
      eveTurnId: "turn-unstarted-successor",
    });
    await database().query(
      "UPDATE memory_review_batches SET started_at = '2026-08-12T09:00:00.000Z' WHERE id = $1",
      [abandoned!.batchId],
    );

    await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-08-12T10:00:00.000Z"),
    });

    // Ровно случай 4 сентября: голова не дошла до Eve, а за ней уже стояла готовая работа. Курсор
    // проходит через голову и забирает завершённого наследника, иначе его проход сгорел бы.
    await expect(database().query(
      `SELECT batch.status::text, batch.diagnostic_code,
              lane.processed_through_sequence::text AS cursor
         FROM memory_review_batches AS batch
         JOIN memory_review_lanes AS lane ON lane.id = batch.lane_id
        WHERE batch.id = $1`,
      [abandoned!.batchId],
    )).resolves.toMatchObject({
      rows: [{
        cursor: "17",
        diagnostic_code: "AGENT_MEMORY_REVIEW_TURN_NEVER_STARTED",
        status: "skipped",
      }],
    });
    await expect(database().query(
      "SELECT batch_diagnostic_code FROM memory_review_owner_alerts WHERE batch_id = $1",
      [abandoned!.batchId],
    )).resolves.toMatchObject({
      rows: [{ batch_diagnostic_code: "AGENT_MEMORY_REVIEW_PASS_SKIPPED" }],
    });
  });

  it("releases a cancelled batch that never bound its turn", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const session = await insertReviewSession(fixture.familyId, fixture.groupId, "review-cancelled");
    const source = await insertReviewTail(fixture, 2);
    const batch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session,
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });

    // Отмена следующим сообщением приходит раньше `turn.started`, поэтому привязки к ходу нет и
    // искать пакет по сессии Eve бесполезно: раньше обработчик отмены здесь молча не делал ничего.
    await expect(memoryReviewRepository.failRunning({
      batchId: batch!.batchId,
      diagnosticCode: "AGENT_MEMORY_REVIEW_TURN_CANCELLED",
      eveSessionId: "eve-cancelled",
      eveTurnId: "turn-cancelled",
    })).resolves.toBe("released");
    await expect(database().query(
      "SELECT count(*)::integer AS batches FROM memory_review_batches WHERE id = $1",
      [batch!.batchId],
    )).resolves.toMatchObject({ rows: [{ batches: 0 }] });
  });

  it("skips a cancelled head with a successor without warning the owner", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const session = await insertReviewSession(fixture.familyId, fixture.groupId, "review-steer");
    const head = await insertReviewTail(fixture, 2);
    const abandoned = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session,
      groupId: fixture.groupId,
      timelineEntryId: head.id,
    });
    const successorSource = await insertReviewTail(fixture, 10);
    await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session,
      groupId: fixture.groupId,
      timelineEntryId: successorSource.id,
    });

    await expect(memoryReviewRepository.failRunning({
      batchId: abandoned!.batchId,
      diagnosticCode: "AGENT_MEMORY_REVIEW_TURN_CANCELLED",
      eveSessionId: "eve-steer",
      eveTurnId: "turn-steer",
    })).resolves.toBe("skipped");
    // Пакет наследника создаётся ещё в обработчике сообщения, поэтому у отменённой головы он есть
    // почти всегда. Дописанное сообщение — обычное поведение чата, а не авария для владельца.
    await expect(database().query(
      `SELECT batch.status::text, (SELECT count(*)::integer FROM memory_review_owner_alerts) AS alerts
         FROM memory_review_batches AS batch WHERE batch.id = $1`,
      [abandoned!.batchId],
    )).resolves.toMatchObject({ rows: [{ alerts: 0, status: "skipped" }] });
  });

});
