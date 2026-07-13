/**
 * PostgreSQL durable Telegram ingress integration tests.
 *
 * Constructs covered:
 * - `telegramIngressRepository.enqueue`: idempotent update ingestion with conflict detection.
 * - `telegramIngressRepository.acceptMedia`: trust-zone decisions and tombstones are update-id atomic.
 * - `telegramIngressRepository.claimNext`: per-continuation FIFO with independent queue progress.
 * - Lease ownership: expired work can be reclaimed while stale workers are rejected.
 * - Continuation aliases: Telegram group re-keying keeps one logical FIFO.
 * - Voice transcript persistence: paid provider results survive delivery retries.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { telegramIngressRepository } from "./telegram-ingress-repository.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;
const LEASE_MILLISECONDS = 60_000;

if (integrationTestsEnabled) {
  if (!integrationDatabaseUrl) {
    throw new Error(
      "AGENT_TEST_DATABASE_CONFIG_MISSING: Для integration-тестов не задан DATABASE_URL",
    );
  }
  if (!new URL(integrationDatabaseUrl).pathname.slice(1).endsWith("_test")) {
    throw new Error(
      "AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test",
    );
  }
}

const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;

function updateInput(updateId: string, continuationKey: string, text: string) {
  return {
    continuationKey,
    payload: {
      message: {
        chat: { id: continuationKey, type: "private" },
        message_id: Number(updateId),
        text,
      },
      update_id: Number(updateId),
    },
    updateId,
  };
}

describeWithDatabase("telegramIngressRepository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE telegram_ingress_ignored_updates, telegram_ingress_updates, telegram_ingress_continuation_aliases, telegram_ingress_queues CASCADE",
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("deduplicates an identical update and rejects a conflicting replay", async () => {
    const update = updateInput("1001", "telegram:private:101", "первое сообщение");

    await expect(telegramIngressRepository.enqueue(update)).resolves.toBe("inserted");
    await expect(telegramIngressRepository.enqueue(update)).resolves.toBe("duplicate");
    await expect(
      telegramIngressRepository.enqueue({ ...update, payload: { ...update.payload, forged: true } }),
    ).rejects.toThrowError(/AGENT_TELEGRAM_UPDATE_CONFLICT/);

    const count = await database().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM telegram_ingress_updates",
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("keeps a rejected update tombstoned after the group becomes family-private", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Ingress policy family') RETURNING id",
    );
    await database().query(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
       VALUES ($1, '-100-policy', 'Policy group', 'external_public', 'addressed_only', '{}')`,
      [family.rows[0]!.id],
    );
    const update = updateInput("1002", "telegram:group:-100-policy", "повтор после смены зоны");

    await expect(telegramIngressRepository.acceptMedia({
      chatId: "-100-policy",
      chatType: "supergroup",
      updateId: update.updateId,
    })).resolves.toBe(false);
    await database().query(
      "UPDATE telegram_groups SET type = 'family_private' WHERE telegram_chat_id = '-100-policy'",
    );
    await expect(telegramIngressRepository.acceptMedia({
      chatId: "-100-policy",
      chatType: "supergroup",
      updateId: update.updateId,
    })).resolves.toBe(false);
    await expect(telegramIngressRepository.enqueue(update)).resolves.toBe("duplicate");

    const retained = await database().query<{ ignored: string; queued: string }>(
      `SELECT
         (SELECT count(*)::text FROM telegram_ingress_ignored_updates) AS ignored,
         (SELECT count(*)::text FROM telegram_ingress_updates) AS queued`,
    );
    expect(retained.rows[0]).toEqual({ ignored: "1", queued: "0" });
    await expect(telegramIngressRepository.claimNext(LEASE_MILLISECONDS)).resolves.toBeNull();
  });

  it("claims only the oldest update per queue while another queue progresses", async () => {
    await telegramIngressRepository.enqueue(updateInput("2001", "telegram:private:101", "один"));
    await telegramIngressRepository.enqueue(updateInput("2002", "telegram:private:101", "два"));
    await telegramIngressRepository.enqueue(updateInput("2003", "telegram:private:202", "другая очередь"));

    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    const independent = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    const blocked = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);

    expect(first?.updateId).toBe("2001");
    expect(independent?.updateId).toBe("2003");
    expect(blocked).toBeNull();

    await telegramIngressRepository.completeWithSession(
      first!.updateId,
      first!.leaseToken,
      "eve-session-2001",
    );

    await expect(telegramIngressRepository.claimNext(LEASE_MILLISECONDS)).resolves.toMatchObject({
      updateId: "2002",
    });
  });

  it("reclaims an expired lease and rejects the stale worker token", async () => {
    await telegramIngressRepository.enqueue(updateInput("3001", "telegram:private:101", "lease"));
    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    expect(first).not.toBeNull();
    await database().query(
      "UPDATE telegram_ingress_updates SET lease_expires_at = now() - interval '1 second' WHERE update_id = $1",
      [first!.updateId],
    );

    const reclaimed = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);

    expect(reclaimed?.updateId).toBe(first?.updateId);
    expect(reclaimed?.leaseToken).not.toBe(first?.leaseToken);
    await expect(
      telegramIngressRepository.completeWithSession(
        first!.updateId,
        first!.leaseToken,
        "stale-session",
      ),
    ).rejects.toThrowError(/AGENT_TELEGRAM_LEASE_LOST/);
  });

  it("keeps new Telegram anchors in the same logical FIFO", async () => {
    await telegramIngressRepository.enqueue(updateInput("4001", "telegram:group:old", "первое"));
    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    expect(first).not.toBeNull();

    await telegramIngressRepository.rekeyQueue({
      nextContinuationKey: "telegram:group:new",
      previousContinuationKey: "telegram:group:old",
      queueId: first!.queueId,
    });
    await telegramIngressRepository.enqueue(updateInput("4002", "telegram:group:new", "следующее"));
    await telegramIngressRepository.release(first!.updateId, first!.leaseToken, {
      code: "AGENT_TELEGRAM_DELIVERY_INTERRUPTED",
      message: "Передача сообщения в Eve была прервана. Обработка будет запущена повторно",
    });

    const reclaimed = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    expect(reclaimed).toMatchObject({
      deliveryContinuationKey: "telegram:group:new",
      queueId: first!.queueId,
      updateId: "4001",
    });
  });

  it("persists one voice transcript across a released delivery attempt", async () => {
    await telegramIngressRepository.enqueue({
      ...updateInput("5001", "telegram:private:101", ""),
      voice: {
        fileId: "telegram-file-5001",
        fileSize: 512,
        mimeType: "audio/ogg",
      },
    });
    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);

    await telegramIngressRepository.beginVoiceTranscription(first!.updateId, first!.leaseToken);
    await telegramIngressRepository.saveVoiceTranscript(
      first!.updateId,
      first!.leaseToken,
      "Купи молоко",
    );
    await telegramIngressRepository.release(first!.updateId, first!.leaseToken, {
      code: "AGENT_TELEGRAM_DELIVERY_INTERRUPTED",
      message: "Передача сообщения в Eve была прервана. Обработка будет запущена повторно",
    });
    const reclaimed = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);

    expect(reclaimed).toMatchObject({
      transcript: "Купи молоко",
      updateId: "5001",
      voice: {
        fileId: "telegram-file-5001",
        fileSize: 512,
        mimeType: "audio/ogg",
      },
    });
    await expect(
      telegramIngressRepository.beginVoiceTranscription(
        reclaimed!.updateId,
        reclaimed!.leaseToken,
      ),
    ).resolves.toBe("completed");
    await expect(
      telegramIngressRepository.saveVoiceTranscript(
        reclaimed!.updateId,
        reclaimed!.leaseToken,
        "Другой результат",
      ),
    ).rejects.toThrowError(/AGENT_VOICE_TRANSCRIPT_CONFLICT/);
  });

  it("does not repeat a provider call after transcription started without a saved result", async () => {
    await telegramIngressRepository.enqueue({
      ...updateInput("5002", "telegram:private:101", ""),
      voice: { fileId: "telegram-file-5002" },
    });
    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    await telegramIngressRepository.beginVoiceTranscription(first!.updateId, first!.leaseToken);
    await telegramIngressRepository.release(first!.updateId, first!.leaseToken, {
      code: "AGENT_PROCESS_INTERRUPTED",
      message: "Процесс был прерван",
    });
    const reclaimed = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);

    await expect(
      telegramIngressRepository.beginVoiceTranscription(
        reclaimed!.updateId,
        reclaimed!.leaseToken,
      ),
    ).rejects.toThrowError(/AGENT_VOICE_TRANSCRIPTION_RECOVERY_REQUIRED/);
  });

  it("does not repeat an Eve dispatch after its durable start marker", async () => {
    await telegramIngressRepository.enqueue(updateInput("6001", "telegram:private:101", "действие"));
    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    await telegramIngressRepository.beginDispatch(first!.updateId, first!.leaseToken);
    await telegramIngressRepository.release(first!.updateId, first!.leaseToken, {
      code: "AGENT_PROCESS_INTERRUPTED",
      message: "Процесс был прерван",
    });
    const reclaimed = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);

    await expect(
      telegramIngressRepository.beginDispatch(reclaimed!.updateId, reclaimed!.leaseToken),
    ).rejects.toThrowError(/AGENT_TELEGRAM_DISPATCH_RECOVERY_REQUIRED/);
  });
});
