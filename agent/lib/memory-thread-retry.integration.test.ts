/**
 * Server-enforced memory-thread candidate retry integration tests.
 *
 * Constructs covered:
 * - Candidate replay is idempotent and payload-bound without another E5 request.
 * - A source permits one refined retry whether that retry is rejected or succeeds.
 * - Explicit candidate attachment closes the mutually exclusive refined-create branch.
 * - Pending reservations serialize concurrent calls before E5.
 * - Expired calls are reclaimed while revoked callers cannot finalize outcomes.
 * - Candidate replay survives ordinary timeline retention.
 *
 * The counts include the neighbour probe: since #208 every semantic write embeds one passage, and
 * a thread creation sends its title in the same request. What this file measures is unchanged —
 * that a retry spends no embedding beyond its own attempt.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const POSITIVE_VECTOR = [1, ...Array.from({ length: 383 }, () => 0)];
const DISTINCT_VECTOR = [0, 1, ...Array.from({ length: 382 }, () => 0)];

vi.mock("./memory-embedding-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./memory-embedding-client.js")>(),
  embedMemoryPassages: vi.fn(async () => [POSITIVE_VECTOR]),
}));

import { closeDatabase, database } from "./database.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import { embedMemoryPassages } from "./memory-embedding-client.js";
import { memoryRepository } from "./memory-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

async function createRetryScenario() {
  const fixture = await createMainAgentMemoryFixture();
  const retrySource = await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     VALUES ($1, $2, 902, 2, 'user', 'telegram:agent-memory-author', 'agent-memory-author',
             'Анна', false, 'text', 'Создай отдельную тему здоровья', now()) RETURNING id`,
    [fixture.conversationId, fixture.groupId],
  );
  const create = (operationKey: string, title: string) => memoryRepository.create(fixture.auth, {
    confirmation: "user_confirmed",
    content: `Отдельная тема здоровья: ${title}`,
    explicitSource: {
      conversationId: fixture.conversationId,
      subject: { kind: "current_author" },
      timelineEntryId: retrySource.rows[0]!.id,
    },
    kind: "fact",
    operationKey,
    provenance: { sessionId: "retry-session", turnId: "retry-turn" },
    scope: "family",
    sensitivity: "normal",
    source: "eve:retry-session:retry-turn",
    thread: {
      action: "create",
      purpose: "Следить за здоровьем, сном и режимом дня",
      role: "goal",
      title,
    },
  });
  const attach = (operationKey: string, threadRef: string) => memoryRepository.create(fixture.auth, {
    confirmation: "user_confirmed",
    content: "Здоровье относится к выбранной существующей теме",
    explicitSource: {
      conversationId: fixture.conversationId,
      subject: { kind: "current_author" },
      timelineEntryId: retrySource.rows[0]!.id,
    },
    kind: "fact",
    operationKey,
    provenance: { sessionId: "retry-session", turnId: "retry-turn" },
    scope: "family",
    sensitivity: "normal",
    source: "eve:retry-session:retry-turn",
    thread: { action: "attach", role: "goal", threadRef },
  });

  await memoryRepository.create(fixture.auth, {
    confirmation: "model_high",
    content: "Начата инвестиционная тема",
    explicitSource: {
      conversationId: fixture.conversationId,
      subject: { kind: "current_author" },
      timelineEntryId: fixture.timelineEntryId,
    },
    kind: "fact",
    operationKey: "retry-existing-thread",
    scope: "family",
    sensitivity: "normal",
    source: "eve:retry-existing-thread",
    thread: {
      action: "create",
      purpose: "Планировать инвестиционные взносы",
      role: "goal",
      title: "Инвестиции",
    },
  });
  return { attach, create, fixture, retrySourceId: retrySource.rows[0]!.id };
}

describeWithDatabase("memory thread candidate retry", () => {
  beforeEach(async () => {
    vi.mocked(embedMemoryPassages).mockReset().mockResolvedValue([POSITIVE_VECTOR]);
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("replays candidates and rejects a third failed create before another embedding", async () => {
    const { attach, create } = await createRetryScenario();

    await expect(create("retry-candidate-first", "Здоровье"))
      .rejects.toThrowError(/AGENT_MEMORY_THREAD_CANDIDATE_EXISTS/u);
    await expect(create("retry-candidate-first", "Здоровье"))
      .rejects.toThrowError(/AGENT_MEMORY_THREAD_CANDIDATE_EXISTS/u);
    expect(embedMemoryPassages).toHaveBeenCalledTimes(2);
    await expect(create("retry-candidate-first", "Изменённая тема"))
      .rejects.toThrowError(/AGENT_MEMORY_REPLAY_MISMATCH/u);
    expect(embedMemoryPassages).toHaveBeenCalledTimes(2);
    await expect(create("retry-candidate-second", "Физическая форма"))
      .rejects.toThrowError(/AGENT_MEMORY_THREAD_CANDIDATE_EXISTS/u);
    const candidate = await database().query<{ thread_ref: string }>(
      `SELECT candidate_thread_refs[1] AS thread_ref
       FROM memory_thread_creation_attempts WHERE operation_key = 'retry-candidate-first'`,
    );
    await expect(create("retry-candidate-third", "Сон и режим"))
      .rejects.toThrowError(/AGENT_MEMORY_THREAD_RETRY_EXHAUSTED/u);
    await expect(attach("retry-candidate-late-attach", candidate.rows[0]!.thread_ref))
      .resolves.toMatchObject({ thread: { action: "attached" } });
    await expect(attach("retry-candidate-late-repeat", candidate.rows[0]!.thread_ref))
      .rejects.toThrowError(/AGENT_MEMORY_THREAD_RESOLUTION_COMPLETED/u);

    expect(embedMemoryPassages).toHaveBeenCalledTimes(5);
    await expect(database().query(
      `SELECT count(*)::integer AS attempts,
              count(DISTINCT operation_key)::integer AS operation_keys
       FROM memory_thread_creation_attempts`,
    )).resolves.toMatchObject({ rows: [{ attempts: 2, operation_keys: 2 }] });
    await expect(database().query(
      "SELECT status FROM memory_thread_creation_attempts ORDER BY attempt_number",
    )).resolves.toMatchObject({ rows: [{ status: "resolved" }, { status: "resolved" }] });
    await expect(database().query(
      "SELECT operation_key FROM memory_items WHERE source = $1 ORDER BY operation_key",
      ["eve:retry-session:retry-turn"],
    )).resolves.toMatchObject({ rows: [{ operation_key: "retry-candidate-late-attach" }] });
  });

  it("closes the retry budget when the refined create succeeds", async () => {
    vi.mocked(embedMemoryPassages)
      .mockResolvedValueOnce([POSITIVE_VECTOR])
      .mockResolvedValueOnce([POSITIVE_VECTOR])
      .mockResolvedValueOnce([DISTINCT_VECTOR]);
    const { attach, create } = await createRetryScenario();

    await expect(create("retry-success-first", "Здоровье"))
      .rejects.toThrowError(/AGENT_MEMORY_THREAD_CANDIDATE_EXISTS/u);
    const candidate = await database().query<{ thread_ref: string }>(
      `SELECT candidate_thread_refs[1] AS thread_ref
       FROM memory_thread_creation_attempts WHERE operation_key = 'retry-success-first'`,
    );
    await expect(create("retry-success-second", "Физическая форма"))
      .resolves.toMatchObject({ thread: { action: "created" } });
    await expect(attach("retry-success-attach", candidate.rows[0]!.thread_ref))
      .rejects.toThrowError(/AGENT_MEMORY_THREAD_RESOLUTION_COMPLETED/u);
    await expect(create("retry-success-third", "Сон и режим"))
      .rejects.toThrowError(/AGENT_MEMORY_THREAD_RETRY_EXHAUSTED/u);

    expect(embedMemoryPassages).toHaveBeenCalledTimes(4);
    await expect(database().query(
      "SELECT status FROM memory_thread_creation_attempts ORDER BY attempt_number",
    )).resolves.toMatchObject({ rows: [{ status: "candidate" }, { status: "completed" }] });
  });

  it("closes the refined-create branch after attaching the candidate", async () => {
    const { attach, create } = await createRetryScenario();

    await expect(create("retry-attach-first", "Здоровье"))
      .rejects.toThrowError(/AGENT_MEMORY_THREAD_CANDIDATE_EXISTS/u);
    const candidate = await database().query<{ thread_ref: string }>(
      `SELECT candidate_thread_refs[1] AS thread_ref
       FROM memory_thread_creation_attempts WHERE operation_key = 'retry-attach-first'`,
    );
    const attached = await Promise.all([
      attach("retry-attach-resolution", candidate.rows[0]!.thread_ref),
      attach("retry-attach-resolution", candidate.rows[0]!.thread_ref),
    ]);
    expect(attached).toMatchObject([
      { thread: { action: "attached" } },
      { thread: { action: "attached" } },
    ]);
    await expect(attach("retry-attach-repeated", candidate.rows[0]!.thread_ref))
      .rejects.toThrowError(/AGENT_MEMORY_THREAD_RESOLUTION_COMPLETED/u);
    await expect(create("retry-attach-third", "Физическая форма"))
      .rejects.toThrowError(/AGENT_MEMORY_THREAD_RETRY_EXHAUSTED/u);

    expect(embedMemoryPassages).toHaveBeenCalledTimes(5);
    await expect(database().query(
      "SELECT status FROM memory_thread_creation_attempts WHERE operation_key = 'retry-attach-first'",
    )).resolves.toMatchObject({ rows: [{ status: "resolved" }] });
  });

  it("serializes pending creates for one source before embedding", async () => {
    const { create } = await createRetryScenario();
    let resolveInitial!: (value: number[][]) => void;
    vi.mocked(embedMemoryPassages).mockImplementationOnce(() => new Promise((resolve) => {
      resolveInitial = resolve;
    }));

    const initial = create("retry-pending-first", "Здоровье");
    await vi.waitFor(() => expect(embedMemoryPassages).toHaveBeenCalledTimes(2));
    try {
      await expect(create("retry-pending-parallel", "Физическая форма"))
        .rejects.toThrowError(/AGENT_MEMORY_THREAD_ATTEMPT_IN_PROGRESS/u);
    } finally {
      resolveInitial([POSITIVE_VECTOR]);
    }
    await expect(initial).rejects.toThrowError(/AGENT_MEMORY_THREAD_CANDIDATE_EXISTS/u);

    let resolveRetry!: (value: number[][]) => void;
    vi.mocked(embedMemoryPassages).mockImplementationOnce(() => new Promise((resolve) => {
      resolveRetry = resolve;
    }));
    const retry = create("retry-pending-second", "Физическая форма");
    await vi.waitFor(() => expect(embedMemoryPassages).toHaveBeenCalledTimes(3));
    try {
      await expect(create("retry-pending-third", "Сон и режим"))
        .rejects.toThrowError(/AGENT_MEMORY_THREAD_RETRY_EXHAUSTED/u);
    } finally {
      resolveRetry([POSITIVE_VECTOR]);
    }
    await expect(retry).rejects.toThrowError(/AGENT_MEMORY_THREAD_CANDIDATE_EXISTS/u);
  });

  it("reclaims an expired operation lease without accepting its stale execution", async () => {
    const { create } = await createRetryScenario();
    let resolveAbandoned!: (value: number[][]) => void;
    vi.mocked(embedMemoryPassages).mockImplementationOnce(() => new Promise((resolve) => {
      resolveAbandoned = resolve;
    }));

    const abandoned = create("retry-expired-operation", "Здоровье");
    await vi.waitFor(() => expect(embedMemoryPassages).toHaveBeenCalledTimes(2));
    await database().query(
      `UPDATE memory_thread_creation_attempts
       SET lease_expires_at = now() - interval '1 second'
       WHERE operation_key = 'retry-expired-operation'`,
    );
    await expect(create("retry-expired-operation", "Здоровье"))
      .rejects.toThrowError(/AGENT_MEMORY_THREAD_CANDIDATE_EXISTS/u);
    resolveAbandoned([POSITIVE_VECTOR]);
    await expect(abandoned).rejects.toThrowError(/AGENT_MEMORY_THREAD_ATTEMPT_STALE/u);

    expect(embedMemoryPassages).toHaveBeenCalledTimes(3);
    await expect(database().query(
      "SELECT status, count(*)::integer AS count FROM memory_thread_creation_attempts GROUP BY status",
    )).resolves.toMatchObject({ rows: [{ count: 1, status: "candidate" }] });
  });

  it("drops a reservation when live membership is revoked during embedding", async () => {
    const { create, fixture } = await createRetryScenario();
    let resolveEmbedding!: (value: number[][]) => void;
    vi.mocked(embedMemoryPassages).mockImplementationOnce(() => new Promise((resolve) => {
      resolveEmbedding = resolve;
    }));

    const pending = create("retry-revoked-operation", "Здоровье");
    await vi.waitFor(() => expect(embedMemoryPassages).toHaveBeenCalledTimes(2));
    await database().query(
      "DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2",
      [fixture.auth.familyId, fixture.userId],
    );
    resolveEmbedding([POSITIVE_VECTOR]);
    await expect(pending).rejects.toThrowError(/AGENT_ACCESS_DENIED/u);

    await expect(database().query(
      "SELECT count(*)::integer AS count FROM memory_thread_creation_attempts",
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("replays a candidate after ordinary timeline retention removes its source row", async () => {
    const { create, retrySourceId } = await createRetryScenario();

    await expect(create("retry-retained-candidate", "Здоровье"))
      .rejects.toThrowError(/AGENT_MEMORY_THREAD_CANDIDATE_EXISTS/u);
    await database().query("DELETE FROM telegram_group_messages WHERE id = $1", [retrySourceId]);
    await expect(create("retry-retained-candidate", "Здоровье"))
      .rejects.toThrowError(/AGENT_MEMORY_THREAD_CANDIDATE_EXISTS/u);

    expect(embedMemoryPassages).toHaveBeenCalledTimes(2);
  });
});
