/**
 * Private-origin memory-thread notice integration tests.
 *
 * Constructs covered:
 * - A thread created from verified private Telegram evidence queues one private-chat notice.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./memory-embedding-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./memory-embedding-client.js")>(),
  embedMemoryPassages: vi.fn(async () => [
    [1, ...Array.from({ length: 383 }, () => 0)],
  ]),
}));

import { closeDatabase, database } from "./database.js";
import { createMainAgentPrivateMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import { memoryRepository } from "./memory-repository.js";
import { memoryThreadNoticeRepository } from "./memory-thread-notice-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

describeWithDatabase("private memory thread notice", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("queues and takes a notice for a private-origin personal thread", async () => {
    const fixture = await createMainAgentPrivateMemoryFixture();

    await memoryRepository.create(fixture.auth, {
      confirmation: "model_high",
      content: "Анна начала готовиться к марафону",
      explicitSource: {
        conversationId: fixture.conversationId,
        subject: { kind: "current_author" },
        timelineEntryId: fixture.timelineEntryId,
      },
      kind: "fact",
      operationKey: "private-personal-thread-notice",
      scope: "personal",
      sensitivity: "normal",
      source: "turn:private-thread-notice",
      thread: {
        action: "create",
        purpose: "Сохранять цели, решения и результаты подготовки",
        role: "goal",
        title: "Марафон",
      },
    });

    await expect(database().query(
      "SELECT status, origin_conversation_id FROM memory_thread_creation_notices",
    )).resolves.toMatchObject({ rows: [{
      origin_conversation_id: fixture.conversationId,
      status: "pending",
    }] });
    await expect(memoryThreadNoticeRepository.takePending(
      fixture.auth,
      fixture.conversationId,
    )).resolves.toMatchObject({ title: "Марафон" });
  });
});
