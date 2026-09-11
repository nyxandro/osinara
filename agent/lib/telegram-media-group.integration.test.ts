import { randomUUID } from "node:crypto";
import type { TelegramDrainContext } from "eve/channels/telegram";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, database } from "./database.js";
import { telegramIngressRepository as repository } from "./telegram-ingress-repository.js";
import { createTelegramDurableIngress } from "./telegram-durable-ingress.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";
import { repositories, telegramContext } from "./telegram-on-message.test-fixtures.js";
import { createTelegramWorkspaceAttachmentImporter } from "./attachments/telegram-workspace-attachments.js";
import { correlatedDispatch } from "./telegram-ingress.test-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Требуется изолированная тестовая БД");
}
function input(id: number, caption = "", chat = 101, group = "album-1") {
  return { updateId: String(id), continuationKey: `${chat}::`, payload: {
    update_id: id, message: { message_id: id, date: 1789090000,
      chat: { id: chat, type: "private" }, from: { id: chat, is_bot: false },
      media_group_id: group, caption,
      document: { file_id: `file-${id}`, file_name: `${id}.txt` } },
  } };
}
async function ready() {
  await database().query("UPDATE telegram_ingress_updates SET media_group_ready_at = now() - interval '1 second' WHERE media_group_key IS NOT NULL");
}
const lease = 60_000;

async function drain(dispatch: TelegramDrainContext["dispatch"], notifyTimeout = vi.fn()) {
  const ingress = createTelegramDurableIngress({ repository, botUsername: "osinara_bot", leaseMilliseconds: lease,
    acceptMedia: vi.fn(), authorizeVoice: vi.fn(), handleSoftwareUpdateCallback: vi.fn(), transcribeVoice: vi.fn(),
  });
  const tasks: Promise<unknown>[] = [];
  await ingress.drain({ attachSession: vi.fn(), dispatch: correlatedDispatch(dispatch), notifyTimeout,
    waitUntil(task) { tasks.push(task); } });
  await Promise.all(tasks);
}

(enabled ? describe : describe.skip)("durable private Telegram albums", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE telegram_ingress_queues, telegram_ingress_ignored_updates, eve_session_event_cursors CASCADE");
  });
  afterAll(closeDatabase);

  it("runs the real ingress, private handler and importer once for all four files", async () => {
    const dependencies = repositories();
    dependencies.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1", role: "owner", userId: "user-1", status: "active",
    });
    const writeBinary = vi.fn().mockImplementation(async (_auth, file) => ({ ...file, scope: "personal" }));
    const attachments = createTelegramWorkspaceAttachmentImporter({
      download: vi.fn().mockImplementation(async file => Buffer.from(file.fileId)), writeBinary,
    });
    const handleMessage = createTelegramMessageHandler({ ...dependencies, attachments });
    const context = telegramContext();
    const dispatch = vi.fn<TelegramDrainContext["dispatch"]>(async update => {
      if (update.kind !== "message") throw new Error("Expected album");
      const result = await handleMessage(context.context, update.message);
      expect(result).not.toBeNull();
      return { id: "album-session", getEventStream: async () => new ReadableStream({ start(controller) {
        controller.enqueue({ type: "session.waiting" }); controller.close();
      } }) } as unknown as Awaited<ReturnType<TelegramDrainContext["dispatch"]>>;
    });
    for (const id of [1001, 1002, 1003, 1004]) await repository.enqueue(input(id, id === 1004 ? "Проверь оба сервера" : ""));
    await ready();
    await drain(dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(writeBinary).toHaveBeenCalledTimes(4);
    expect(dependencies.groupContext.prepare).toHaveBeenCalledWith(expect.objectContaining({ messageText: "Проверь оба сервера" }));
    expect(dependencies.session.prepareTurn).toHaveBeenCalledTimes(1);
    expect(context.sendMessage).not.toHaveBeenCalled();
    expect((await database().query("SELECT status FROM telegram_ingress_updates")).rows)
      .toEqual(Array.from({ length: 4 }, () => ({ status: "completed" })));
    await repository.enqueue(input(1004, "Проверь оба сервера"));
    await drain(dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("waits for the album while another chat progresses", async () => {
    await repository.enqueue(input(1001));
    await expect(repository.claimNext(lease)).resolves.toBeNull();
    const other = input(1002, "hello", 202);
    delete (other.payload.message as Partial<typeof other.payload.message>).media_group_id;
    await repository.enqueue(other);
    expect((await repository.claimNext(lease))?.updateId).toBe("1002");
  });

  it("starts a fresh quiet window for a new member and keeps following text behind the album", async () => {
    await repository.enqueue(input(1001));
    await ready();
    await repository.enqueue(input(1002));
    const next = input(1003, "Следующий вопрос");
    delete (next.payload.message as Partial<typeof next.payload.message>).media_group_id;
    await repository.enqueue(next);
    expect(await repository.claimNext(lease)).toBeNull();
    await ready();
    const first = (await repository.claimNext(lease))!;
    await repository.fail(first.updateId, first.leaseToken, { code: "AGENT_TEST_FAILURE", message: "Test failed dispatch" });
    expect((await database().query("SELECT status FROM telegram_ingress_updates WHERE update_id IN (1001,1002)")).rows)
      .toEqual([{ status: "failed" }, { status: "failed" }]);
    expect((await repository.claimNext(lease))?.updateId).toBe("1003");
  });

  it("serializes sealing against a concurrently arriving member", async () => {
    await repository.enqueue(input(1001));
    await ready();
    const [claimed] = await Promise.all([repository.claimNext(lease), repository.enqueue(input(1002))]);
    if (claimed) {
      expect(claimed.mediaGroupPayloads).toHaveLength(1);
      const member = (await database().query("SELECT media_group_late FROM telegram_ingress_updates WHERE update_id = 1002")).rows[0];
      expect(member.media_group_late).toBe(true);
    } else {
      await ready();
      expect((await repository.claimNext(lease))?.mediaGroupPayloads).toHaveLength(2);
    }
  });

  it("keeps group messages as separate journal sources", async () => {
    for (const id of [1001, 1002]) {
      const update = input(id, "", -100);
      update.payload.message.chat.type = "supergroup";
      await repository.enqueue(update);
    }
    const first = (await repository.claimNext(lease))!;
    expect(first.mediaGroupPayloads).toBeUndefined();
    await repository.complete(first.updateId, first.leaseToken);
    expect((await repository.claimNext(lease))?.updateId).toBe("1002");
  });

  it("dispatches four updates once, preserves FIFO and completes every member together", async () => {
    for (const id of [1001, 1002, 1003, 1004]) await repository.enqueue(input(id, id === 1004 ? "Проверь" : ""));
    const next = input(1005, "Следующий вопрос");
    delete (next.payload.message as Partial<typeof next.payload.message>).media_group_id;
    await repository.enqueue(next);
    await ready();
    const claims = (await Promise.all(Array.from({ length: 4 }, () => repository.claimNext(lease)))).filter(Boolean);
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expect(claim.mediaGroupPayloads).toHaveLength(4);
    await repository.completeWithSession(claim.updateId, claim.leaseToken, "album-session", 8);
    const rows = await database().query("SELECT status, eve_session_id FROM telegram_ingress_updates WHERE update_id <= 1004 ORDER BY update_id");
    expect(rows.rows).toEqual(Array.from({ length: 4 }, () => ({ status: "completed", eve_session_id: "album-session" })));
    expect((await repository.claimNext(lease))?.updateId).toBe("1005");
  });

  it("deduplicates members without extending the collection deadline and sorts out-of-order arrivals", async () => {
    await repository.enqueue(input(1003));
    await repository.enqueue(input(1001));
    await repository.enqueue(input(1002, "Подпись"));
    await ready();
    expect(await repository.enqueue(input(1001))).toBe("duplicate");
    const claim = (await repository.claimNext(lease))!;
    expect(claim.updateId).toBe("1003");
    expect(claim.mediaGroupPayloads?.map(payload => payload.update_id)).toEqual([1001, 1002, 1003]);
    await repository.complete(claim.updateId, claim.leaseToken);
    await expect(repository.claimNext(lease)).resolves.toBeNull();
  });

  it("keeps sealed membership after lease loss and rejects stale completion", async () => {
    await repository.enqueue(input(1001));
    await repository.enqueue(input(1002));
    await ready();
    const first = (await repository.claimNext(lease))!;
    await database().query("UPDATE telegram_ingress_updates SET lease_expires_at = now() - interval '1 second' WHERE update_id = 1001");
    const recovered = (await repository.claimNext(lease))!;
    expect(recovered.mediaGroupPayloads).toEqual(first.mediaGroupPayloads);
    await expect(repository.complete(first.updateId, first.leaseToken)).rejects.toThrow(/AGENT_TELEGRAM_LEASE_LOST/);
    await repository.complete(recovered.updateId, recovered.leaseToken);
    expect((await database().query("SELECT status FROM telegram_ingress_updates")).rows).toEqual([{ status: "completed" }, { status: "completed" }]);
  });

  it("retains the exact dispatch binding for recovery and quarantines the entire album", async () => {
    await repository.enqueue(input(1001));
    await repository.enqueue(input(1002));
    await ready();
    const claim = (await repository.claimNext(lease))!;
    const dispatchId = randomUUID();
    await repository.beginDispatch(claim.updateId, claim.leaseToken, dispatchId);
    await database().query("UPDATE telegram_ingress_updates SET dispatch_session_id = 'session-1', dispatch_turn_id = 'turn_1', dispatch_start_index = 0 WHERE update_id = 1001");
    await repository.fail(claim.updateId, claim.leaseToken, { code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED", message: "Остановка не подтверждена" });
    const recovered = (await repository.claimNext(lease))!;
    expect(recovered.dispatchBinding).toMatchObject({ id: dispatchId, sessionId: "session-1" });
    expect(recovered.mediaGroupPayloads).toHaveLength(2);
    await repository.completeWithSession(recovered.updateId, recovered.leaseToken, "session-1", 9);
    await expect(repository.claimNext(lease)).resolves.toBeNull();
  });

  it("marks a late member for an explicit notice instead of a second model turn", async () => {
    await repository.enqueue(input(1001));
    await ready();
    const claim = (await repository.claimNext(lease))!;
    await repository.enqueue(input(1002));
    await repository.complete(claim.updateId, claim.leaseToken);
    const late = (await repository.claimNext(lease))!;
    expect(late.updateId).toBe("1002");
    expect(late.mediaGroupLate).toBe(true);
    expect(late.mediaGroupPayloads).toBeUndefined();
    await repository.release(late.updateId, late.leaseToken, { code: "AGENT_TEST_RELEASE", message: "Test restart" });
    const dispatch = vi.fn().mockResolvedValue(null);
    const notify = vi.fn().mockResolvedValue(undefined);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await drain(dispatch, notify);
      expect(dispatch).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: expect.objectContaining({ messageId: "1002" }) }),
        expect.stringContaining("AGENT_TELEGRAM_MEDIA_GROUP_LATE"), expect.any(AbortSignal));
      expect((await database().query("SELECT status FROM telegram_ingress_updates WHERE update_id = 1002")).rows[0]?.status).toBe("failed");
    } finally { log.mockRestore(); }
  });

  it("never combines identical album ids across chats or distinct albums within a chat", async () => {
    await repository.enqueue(input(1001));
    await repository.enqueue(input(1002, "", 202));
    await repository.enqueue(input(1003, "", 101, "album-2"));
    await ready();
    const first = (await repository.claimNext(lease))!;
    const other = (await repository.claimNext(lease))!;
    expect([first.mediaGroupPayloads?.length, other.mediaGroupPayloads?.length]).toEqual([1, 1]);
    expect(other.updateId).toBe("1002");
    await repository.complete(first.updateId, first.leaseToken);
    expect((await repository.claimNext(lease))?.updateId).toBe("1003");
  });
});
