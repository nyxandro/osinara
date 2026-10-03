/**
 * Voice message operation ledger integration tests.
 *
 * Constructs covered:
 * - One operation key reserves exactly one billable synthesis attempt.
 * - Completed results replay with the recorded ElevenLabs character cost.
 * - Input drift and ambiguous outcomes fail closed.
 * - Workspace deletion keeps the billing ledger tombstone.
 * - The delivery ledger accepts the voice presentation.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { voiceMessageOperationRepository } from "./voice-message-operation-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;
const FILE = {
  byteSize: 12,
  contentSha256: "b".repeat(64),
  mediaType: "audio/ogg; codecs=opus",
  path: "generated-voice/voice-ledger.ogg",
  scope: "personal" as const,
  updatedAt: "2026-09-23T00:00:00.000Z",
};

async function workspace(): Promise<{ familyId: string; workspaceId: string }> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Voice messages') RETURNING id",
  );
  const familyId = family.rows[0]!.id;
  const result = await database().query<{ id: string }>(
    "INSERT INTO workspaces (family_id, scope) VALUES ($1, 'family') RETURNING id",
    [familyId],
  );
  return { familyId, workspaceId: result.rows[0]!.id };
}

describeWithDatabase("voice message operation repository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE voice_message_operations, workspace_file_deliveries, workspaces, families CASCADE",
    );
  });
  afterAll(async () => closeDatabase());

  it("reserves once and replays the completed file with its character cost", async () => {
    const { workspaceId } = await workspace();
    const input = {
      inputHash: "a".repeat(64),
      operationKey: "voice-call-1",
      outputPath: FILE.path,
      workspaceId,
    };

    await expect(voiceMessageOperationRepository.begin(input)).resolves.toEqual({
      state: "execute",
      workspaceId,
    });
    await voiceMessageOperationRepository.complete(input.operationKey, FILE, 118);
    await expect(voiceMessageOperationRepository.begin(input)).resolves.toEqual({
      file: FILE,
      state: "completed",
    });
    const ledger = await database().query<{ character_cost: number }>(
      "SELECT character_cost FROM voice_message_operations WHERE operation_key = $1",
      [input.operationKey],
    );
    expect(ledger.rows[0]!.character_cost).toBe(118);
  });

  it("rejects operation-key reuse with different synthesis input", async () => {
    const { workspaceId } = await workspace();
    await voiceMessageOperationRepository.begin({
      inputHash: "a".repeat(64),
      operationKey: "voice-call-mismatch",
      outputPath: FILE.path,
      workspaceId,
    });

    await expect(voiceMessageOperationRepository.begin({
      inputHash: "c".repeat(64),
      operationKey: "voice-call-mismatch",
      outputPath: FILE.path,
      workspaceId,
    })).rejects.toThrowError(/AGENT_VOICE_MESSAGE_REPLAY_MISMATCH/u);
  });

  it("keeps an ambiguous charge terminal", async () => {
    const { workspaceId } = await workspace();
    const input = {
      inputHash: "d".repeat(64),
      operationKey: "voice-call-ambiguous",
      outputPath: FILE.path,
      workspaceId,
    };
    await voiceMessageOperationRepository.begin(input);
    await voiceMessageOperationRepository.markAmbiguous(
      input.operationKey,
      "AGENT_VOICE_MESSAGE_PROVIDER_STATUS_UNKNOWN",
    );

    await expect(voiceMessageOperationRepository.begin(input)).resolves.toEqual({
      errorCode: "AGENT_VOICE_MESSAGE_PROVIDER_STATUS_UNKNOWN",
      state: "ambiguous",
    });
    await expect(voiceMessageOperationRepository.markFailed(
      input.operationKey,
      "AGENT_VOICE_MESSAGE_PROVIDER_REJECTED",
    )).rejects.toThrowError(/AGENT_VOICE_MESSAGE_STATE_INVALID/u);
  });

  it("keeps a terminal operation after its workspace is deleted", async () => {
    const { workspaceId } = await workspace();
    const input = {
      inputHash: "e".repeat(64),
      operationKey: "voice-call-retired-workspace",
      outputPath: FILE.path,
      workspaceId,
    };
    await voiceMessageOperationRepository.begin(input);
    await voiceMessageOperationRepository.markFailed(
      input.operationKey,
      "AGENT_VOICE_MESSAGE_PROVIDER_PAYMENT_REQUIRED",
    );

    await database().query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);

    const ledger = await database().query(
      "SELECT 1 FROM voice_message_operations WHERE operation_key = $1",
      [input.operationKey],
    );
    expect(ledger.rowCount).toBe(1);
  });

  it("accepts a voice presentation in the file delivery ledger", async () => {
    const { familyId, workspaceId } = await workspace();
    const insertDelivery = (operationKey: string, presentation: string) => database().query(
      `INSERT INTO workspace_file_deliveries
         (family_id, workspace_id, file_path, content_sha256, operation_key, telegram_chat_id,
          presentation)
       VALUES ($1, $2, $3, $4, $5, '101', $6)`,
      [familyId, workspaceId, FILE.path, FILE.contentSha256, operationKey, presentation],
    );

    await expect(insertDelivery("voice-delivery-1", "voice")).resolves.toMatchObject({ rowCount: 1 });
    await expect(insertDelivery("audio-delivery-1", "audio"))
      .rejects.toThrowError(/workspace_file_deliveries_presentation_check/u);
  });
});
