/**
 * Durable Google Workspace mutation marker tests.
 *
 * Constructs covered:
 * - A started operation cannot be automatically replayed after an ambiguous crash.
 * - A completed operation returns its persisted result without repeating Google side effects.
 * - Operation keys remain bound to the original user and exact request fingerprint.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { googleOperationRepository } from "./google-operation-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

async function fixture(telegramUserId: string) {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Google operations') RETURNING id",
  );
  const user = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ($1, 'Участник') RETURNING id`,
    [telegramUserId],
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'member')",
    [family.rows[0]!.id, user.rows[0]!.id],
  );
  return {
    familyId: family.rows[0]!.id,
    role: "member" as const,
    telegramChatId: telegramUserId,
    userId: user.rows[0]!.id,
  };
}

describeWithDatabase("Google Workspace operation repository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE integration_operations, family_memberships, users, families CASCADE",
    );
  });
  afterAll(async () => closeDatabase());

  it("blocks a replay while the original mutation outcome is ambiguous", async () => {
    const auth = await fixture("google-operation-1");
    await expect(googleOperationRepository.begin(auth, {
      operationKey: "call-ambiguous",
      requestHash: "a".repeat(64),
    })).resolves.toEqual({ status: "started" });

    await expect(googleOperationRepository.begin(auth, {
      operationKey: "call-ambiguous",
      requestHash: "a".repeat(64),
    })).rejects.toThrowError(/AGENT_GOOGLE_WORKSPACE_OPERATION_AMBIGUOUS/);
  });

  it("returns a completed result for an exact durable replay", async () => {
    const auth = await fixture("google-operation-2");
    const input = { operationKey: "call-completed", requestHash: "b".repeat(64) };
    await googleOperationRepository.begin(auth, input);
    await googleOperationRepository.complete(auth, input, { id: "google-result-1" });

    await expect(googleOperationRepository.begin(auth, input)).resolves.toEqual({
      result: { id: "google-result-1" },
      status: "completed",
    });
  });

  it("rejects reuse of an operation key for another request or user", async () => {
    const first = await fixture("google-operation-3");
    const second = await fixture("google-operation-4");
    await googleOperationRepository.begin(first, {
      operationKey: "call-bound",
      requestHash: "c".repeat(64),
    });

    await expect(googleOperationRepository.begin(first, {
      operationKey: "call-bound",
      requestHash: "d".repeat(64),
    })).rejects.toThrowError(/AGENT_GOOGLE_WORKSPACE_OPERATION_CONFLICT/);
    await expect(googleOperationRepository.begin(second, {
      operationKey: "call-bound",
      requestHash: "c".repeat(64),
    })).rejects.toThrowError(/AGENT_GOOGLE_WORKSPACE_OPERATION_CONFLICT/);
  });
});
