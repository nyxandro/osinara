/**
 * Subscription image generation operation ledger integration tests.
 *
 * Constructs covered:
 * - One operation key reserves exactly one billable generation attempt.
 * - Completed results replay without another provider call.
 * - Input drift and ambiguous outcomes fail closed.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { imageGenerationOperationRepository } from "./image-generation-operation-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;
const FILE = {
  byteSize: 12,
  contentSha256: "b".repeat(64),
  mediaType: "image/webp",
  path: "generated-images/image-ledger.webp",
  scope: "group" as const,
  updatedAt: "2026-08-21T00:00:00.000Z",
};

async function workspace(): Promise<string> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Image generation') RETURNING id",
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
     VALUES ($1, '-100-image-ledger', 'Image group', 'external', 'all', ARRAY['generate_image'])
     RETURNING id`,
    [family.rows[0]!.id],
  );
  const result = await database().query<{ id: string }>(
    "INSERT INTO workspaces (family_id, group_id, scope) VALUES ($1, $2, 'group') RETURNING id",
    [family.rows[0]!.id, group.rows[0]!.id],
  );
  return result.rows[0]!.id;
}

describeWithDatabase("image generation operation repository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE image_generation_operations, telegram_groups, workspaces, families CASCADE",
    );
  });
  afterAll(async () => closeDatabase());

  it("reserves once and replays the completed file", async () => {
    const workspaceId = await workspace();
    const input = {
      inputHash: "a".repeat(64),
      operationKey: "image-call-1",
      outputPath: FILE.path,
      workspaceId,
    };

    await expect(imageGenerationOperationRepository.begin(input)).resolves.toEqual({
      state: "execute",
      workspaceId,
    });
    await imageGenerationOperationRepository.complete(input.operationKey, FILE);
    await expect(imageGenerationOperationRepository.begin(input)).resolves.toEqual({
      file: FILE,
      state: "completed",
    });
  });

  it("rejects operation-key reuse with different generation input", async () => {
    const workspaceId = await workspace();
    await imageGenerationOperationRepository.begin({
      inputHash: "a".repeat(64),
      operationKey: "image-call-mismatch",
      outputPath: FILE.path,
      workspaceId,
    });

    await expect(imageGenerationOperationRepository.begin({
      inputHash: "c".repeat(64),
      operationKey: "image-call-mismatch",
      outputPath: FILE.path,
      workspaceId,
    })).rejects.toThrowError(/AGENT_IMAGE_GENERATION_REPLAY_MISMATCH/u);
  });

  it("keeps an ambiguous charge terminal", async () => {
    const workspaceId = await workspace();
    const input = {
      inputHash: "d".repeat(64),
      operationKey: "image-call-ambiguous",
      outputPath: FILE.path,
      workspaceId,
    };
    await imageGenerationOperationRepository.begin(input);
    await imageGenerationOperationRepository.markAmbiguous(
      input.operationKey,
      "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
    );

    await expect(imageGenerationOperationRepository.begin(input)).resolves.toEqual({
      errorCode: "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
      state: "ambiguous",
    });
  });
});
