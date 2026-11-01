/**
 * PostgreSQL durable Telegram ingress integration tests.
 *
 * Constructs covered:
 * - `telegramIngressRepository.enqueue`: idempotent update ingestion with conflict detection.
 * - `telegramIngressRepository.acceptMedia`: a registered group takes in every medium, an unregistered
 *   chat none; the decision and its tombstone are update-id atomic.
 * - `telegramIngressRepository.claimNext`: per-continuation FIFO with independent queue progress.
 * - Lease ownership: expired work can be reclaimed while stale workers are rejected.
 * - Continuation aliases: Telegram group re-keying keeps one logical FIFO.
 * - Voice transcript persistence: paid provider results survive delivery retries.
 */
import type { TelegramMessage } from "../runtime/telegram/inbound.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// External photos are taken in only for image inspection, so these cases state a vision model
// rather than inheriting the checked-in provider config.
vi.mock("./model-vision-availability.js", () => ({
  MODEL_VISION_AVAILABLE: true,
}));

import { closeDatabase, database } from "./database.js";
import { telegramIngressRepository } from "./telegram-ingress-repository.js";
import {
  BOT_USERNAME,
  groupMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";
import { telegramRepository } from "./telegram-repository.js";
import { NO_BURSTS } from "./telegram-ingress.test-fixtures.js";

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
  it("lets concurrent drainers claim different queues but never two heads of the same queue", async () => {
    await telegramIngressRepository.enqueue(updateInput("1001", "101::", "first"));
    await telegramIngressRepository.enqueue(updateInput("1002", "101::", "second"));
    await telegramIngressRepository.enqueue(updateInput("1003", "202::", "other chat"));
    const claims = (await Promise.all(Array.from({ length: 6 }, () =>
      telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS)))).filter((claim) => claim !== null);
    expect(claims.map((claim) => claim.updateId).sort()).toEqual(["1001", "1003"]);
    expect(await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS)).toBeNull();
    const first = claims.find((claim) => claim.updateId === "1001")!;
    await telegramIngressRepository.complete(first.updateId, first.leaseToken);
    expect((await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS))?.updateId).toBe("1002");
  });
  beforeEach(async () => {
    await database().query(
      `TRUNCATE telegram_ingress_ignored_updates,
         telegram_ingress_updates, telegram_ingress_continuation_aliases,
         telegram_ingress_queues CASCADE`,
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("lets a button press finish during a release drain but holds a reply button like a message", async () => {
    const press = (updateId: string, chatId: number, data: string) => ({
      continuationKey: `${chatId}::`,
      payload: {
        callback_query: { data, from: { id: chatId, is_bot: false }, id: `cb-${updateId}`,
          message: { chat: { id: chatId, type: "private" }, message_id: 50 } },
        update_id: Number(updateId),
      },
      updateId,
    });
    await telegramIngressRepository.enqueue(press("3001", 101, `rb:${"A".repeat(22)}:0`));
    await telegramIngressRepository.enqueue(press("3002", 202, "hitl:0"));
    await database().query(
      "UPDATE runtime_maintenance SET phase = 'draining', owner_token = gen_random_uuid(), updated_at = now()");
    try {
      expect((await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS))?.updateId).toBe("3002");
      expect(await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS)).toBeNull();
    } finally {
      await database().query("UPDATE runtime_maintenance SET phase = 'ready', owner_token = NULL, updated_at = now()");
    }
    expect((await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS))?.updateId).toBe("3001");
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

  it("keeps a rejected update tombstoned after the chat becomes a registered group", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Ingress policy family') RETURNING id",
    );
    const update = updateInput("1002", "telegram:group:-100-policy", "повтор после регистрации");

    // An unregistered chat takes in nothing.
    await expect(telegramIngressRepository.acceptMedia({
      chatId: "-100-policy",
      chatType: "supergroup",
      updateId: update.updateId,
    })).resolves.toBe(false);
    await database().query(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
       VALUES ($1, '-100-policy', 'Policy group', 'family_private', 'addressed_only', '{}')`,
      [family.rows[0]!.id],
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
    await expect(telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS)).resolves.toBeNull();
  });

  it("takes in every medium of a registered external group, whatever its grant list says", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('External media family') RETURNING id",
    );
    await database().query(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
       VALUES
         ($1, '-100-media-plain', 'Plain group', 'external', 'addressed_only', '{}'),
         ($1, '-100-media-malformed', 'Malformed policy', 'external', 'addressed_only',
          ARRAY['inspect_workspace_image', 'unknown_tool'])`,
      [family.rows[0]!.id],
    );

    let updateId = 1010;
    for (const chatId of ["-100-media-plain", "-100-media-malformed"]) {
      // Photos, documents, stickers, voice notes and video alike: the decision no longer looks at the kind.
      for (let medium = 0; medium < 3; medium += 1) {
        await expect(telegramIngressRepository.acceptMedia({
          chatId,
          chatType: "supergroup",
          updateId: String(updateId++),
        }), chatId).resolves.toBe(true);
      }
    }
    await expect(database().query("SELECT count(*)::int AS count FROM telegram_ingress_ignored_updates"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("takes in a photo of a registered external group at the live boundary without any grant", async () => {
    await database().query("DELETE FROM families WHERE name = 'Live photo family'");
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Live photo family') RETURNING id",
    );
    await database().query(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
       VALUES ($1, '-100-live-photo', 'Live photo group', 'external', 'addressed_only', '{}')`,
      [family.rows[0]!.id],
    );
    await expect(telegramIngressRepository.acceptMedia({
      chatId: "-100-live-photo",
      chatType: "supergroup",
      updateId: "1012",
    })).resolves.toBe(true);

    const repository = repositories();
    repository.telegram.findGroup.mockImplementation(telegramRepository.findGroup);
    const message: TelegramMessage = {
      ...groupMessage(`@${BOT_USERNAME} что изображено?`),
      attachments: [{ fileId: "photo-file", fileUniqueId: "photo-id", kind: "photo" }],
      chat: { id: "-100-live-photo", title: "Live photo group", type: "supergroup" },
      raw: {
        date: 1_700_000_000,
        photo: [{ file_id: "photo-file", height: 640, width: 640 }],
      },
    };

    await createTelegramMessageHandler(repository)(telegramContext().context, message);
    expect(repository.journal.record).toHaveBeenCalledOnce();
    expect(repository.attachments.persist).not.toHaveBeenCalled();
    expect(repository.session.prepareTurn).toHaveBeenCalledOnce();
  });

  it("claims only the oldest update per queue while another queue progresses", async () => {
    await telegramIngressRepository.enqueue(updateInput("2001", "telegram:private:101", "один"));
    await telegramIngressRepository.enqueue(updateInput("2002", "telegram:private:101", "два"));
    await telegramIngressRepository.enqueue(updateInput("2003", "telegram:private:202", "другая очередь"));

    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS);
    const independent = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS);
    const blocked = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS);

    expect(first?.updateId).toBe("2001");
    expect(independent?.updateId).toBe("2003");
    expect(blocked).toBeNull();

    await telegramIngressRepository.complete(first!.updateId, first!.leaseToken, "agent-session-2001");

    await expect(telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS)).resolves.toMatchObject({
      updateId: "2002",
    });
  });

  it("records the session an update ran in when it completes", async () => {
    await telegramIngressRepository.enqueue(updateInput("2101", "telegram:private:session", "первый turn"));
    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS);

    await telegramIngressRepository.complete(first!.updateId, first!.leaseToken, "wrun_session");

    await expect(database().query("SELECT status, agent_session_id FROM telegram_ingress_updates WHERE update_id = 2101"))
      .resolves.toMatchObject({ rows: [{ agent_session_id: "wrun_session", status: "completed" }] });
  });

  it("reclaims an expired lease and rejects the stale worker token", async () => {
    await telegramIngressRepository.enqueue(updateInput("3001", "telegram:private:101", "lease"));
    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS);
    expect(first).not.toBeNull();
    await database().query(
      "UPDATE telegram_ingress_updates SET lease_expires_at = now() - interval '1 second' WHERE update_id = $1",
      [first!.updateId],
    );

    const reclaimed = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS);

    expect(reclaimed?.updateId).toBe(first?.updateId);
    expect(reclaimed?.leaseToken).not.toBe(first?.leaseToken);
    await expect(
      telegramIngressRepository.complete(first!.updateId, first!.leaseToken, "stale-session"),
    ).rejects.toThrowError(/AGENT_TELEGRAM_LEASE_LOST/);
  });

  it("keeps new Telegram anchors in the same logical FIFO", async () => {
    await telegramIngressRepository.enqueue(updateInput("4001", "telegram:group:old", "первое"));
    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS);
    expect(first).not.toBeNull();

    await telegramIngressRepository.rekeyQueue({
      nextContinuationKey: "telegram:group:new",
      previousContinuationKey: "telegram:group:old",
      queueId: first!.queueId,
    });
    await telegramIngressRepository.enqueue(updateInput("4002", "telegram:group:new", "следующее"));
    await telegramIngressRepository.release(first!.updateId, first!.leaseToken, {
      code: "AGENT_TELEGRAM_DELIVERY_INTERRUPTED",
      message: "Передача сообщения агенту была прервана. Обработка будет запущена повторно",
    });

    const reclaimed = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS);
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
    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS);

    await telegramIngressRepository.beginVoiceTranscription(first!.updateId, first!.leaseToken);
    await telegramIngressRepository.saveVoiceTranscript(
      first!.updateId,
      first!.leaseToken,
      "Купи молоко",
    );
    await telegramIngressRepository.release(first!.updateId, first!.leaseToken, {
      code: "AGENT_TELEGRAM_DELIVERY_INTERRUPTED",
      message: "Передача сообщения агенту была прервана. Обработка будет запущена повторно",
    });
    const reclaimed = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS);

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
    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS);
    await telegramIngressRepository.beginVoiceTranscription(first!.updateId, first!.leaseToken);
    await telegramIngressRepository.release(first!.updateId, first!.leaseToken, {
      code: "AGENT_PROCESS_INTERRUPTED",
      message: "Процесс был прерван",
    });
    const reclaimed = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS);

    await expect(
      telegramIngressRepository.beginVoiceTranscription(
        reclaimed!.updateId,
        reclaimed!.leaseToken,
      ),
    ).rejects.toThrowError(/AGENT_VOICE_TRANSCRIPTION_RECOVERY_REQUIRED/);
  });

  it("does not repeat a turn dispatch after its durable start marker", async () => {
    await telegramIngressRepository.enqueue(updateInput("6001", "telegram:private:101", "действие"));
    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS);
    await telegramIngressRepository.beginDispatch(first!.updateId, first!.leaseToken, crypto.randomUUID());
    await telegramIngressRepository.release(first!.updateId, first!.leaseToken, {
      code: "AGENT_PROCESS_INTERRUPTED",
      message: "Процесс был прерван",
    });
    const reclaimed = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS, NO_BURSTS);

    await expect(
      telegramIngressRepository.beginDispatch(reclaimed!.updateId, reclaimed!.leaseToken, crypto.randomUUID()),
    ).rejects.toThrowError(/AGENT_TELEGRAM_DISPATCH_RECOVERY_REQUIRED/);
  });
});
