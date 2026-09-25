/**
 * PostgreSQL integration tests for private-chat message bursts.
 *
 * Constructs covered:
 * - A private chat's head waits until the chat has been quiet for the window, then is claimed with
 *   every message already waiting behind it; a steady stream is claimed once the cap has passed.
 * - Buttons and groups are never held, and a button press does not extend a message's wait.
 * - The drain learns exactly when the next held chat becomes ready, and nothing when none is held.
 * - The followers belong to the head: no other claim takes them, and they complete and fail with it.
 * - Once handed to Eve the burst is fixed; a message arriving later starts the next burst.
 * - A button press behind a message ends the burst.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { telegramIngressRepository } from "./telegram-ingress-repository.js";
import { telegramPrivateBurstRepository } from "./telegram-private-burst.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;
if (integrationTestsEnabled && (!integrationDatabaseUrl || !new URL(integrationDatabaseUrl).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test");
}
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;

const LEASE = 60_000;
const BURST = { maxCharacters: 6_000, maxMessages: 10, maxWaitMilliseconds: 20_000, quietMilliseconds: 2_000 };
const PRIVATE = "telegram:private:101";

async function privateText(updateId: string, text: string) {
  await telegramIngressRepository.enqueue({
    continuationKey: PRIVATE,
    payload: {
      message: {
        chat: { id: 101, type: "private" }, date: 1_700_000_000, from: { first_name: "Анна", id: 101, is_bot: false },
        message_id: Number(updateId), text,
      },
      update_id: Number(updateId),
    },
    updateId,
  });
}

async function privateButton(updateId: string) {
  await telegramIngressRepository.enqueue({
    continuationKey: PRIVATE,
    payload: {
      callback_query: {
        chat_instance: "101", data: "eve:1", from: { first_name: "Анна", id: 101, is_bot: false }, id: `callback-${updateId}`,
        message: { chat: { id: 101, type: "private" }, date: 1_700_000_000, from: { first_name: "Osinara", id: 900, is_bot: true }, message_id: 1 },
      },
      update_id: Number(updateId),
    },
    updateId,
  });
}

async function receivedSecondsAgo(seconds: number, ...updateIds: string[]) {
  await database().query(
    "UPDATE telegram_ingress_updates SET received_at = now() - ($2 * interval '1 second') WHERE update_id = ANY($1::bigint[])",
    [updateIds, seconds],
  );
}

function burstIds(payloads: Record<string, unknown>[] | undefined): number[] {
  return (payloads ?? []).map((payload) => payload.update_id as number);
}

async function statusOf(updateId: string): Promise<string> {
  return (await database().query<{ status: string }>("SELECT status FROM telegram_ingress_updates WHERE update_id = $1", [updateId]))
    .rows[0]!.status;
}

describeWithDatabase("private-chat bursts", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE eve_session_event_cursors, telegram_ingress_ignored_updates, telegram_ingress_updates,
         telegram_ingress_continuation_aliases, telegram_ingress_queues CASCADE`,
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("waits until the chat is quiet, then claims the head with everything behind it", async () => {
    await privateText("7001", "вот такой ответ ты прислала");
    await privateText("7002", "мне не нравится");
    await privateText("7003", "нужны только внятные обновления");
    await receivedSecondsAgo(5, "7001", "7002");

    // The newest message is fresh, so the person may still be typing.
    expect(await telegramIngressRepository.claimNext(LEASE, BURST)).toBeNull();
    const readyIn = await telegramPrivateBurstRepository.readyInMilliseconds(BURST);
    expect(readyIn).toBeGreaterThan(0);
    expect(readyIn).toBeLessThanOrEqual(2_000);

    await receivedSecondsAgo(3, "7003");
    expect(await telegramPrivateBurstRepository.readyInMilliseconds(BURST)).toBeNull();
    const head = await telegramIngressRepository.claimNext(LEASE, BURST);
    expect(head?.updateId).toBe("7001");
    expect(burstIds(head?.burstPayloads)).toEqual([7001, 7002, 7003]);
    // The followers belong to the head's turn, so no other claim takes them.
    expect(await telegramIngressRepository.claimNext(LEASE, BURST)).toBeNull();

    await telegramIngressRepository.complete(head!.updateId, head!.leaseToken);
    expect([await statusOf("7002"), await statusOf("7003")]).toEqual(["completed", "completed"]);
    expect(await telegramIngressRepository.claimNext(LEASE, BURST)).toBeNull();
  });

  it("fails the whole burst with its head", async () => {
    await privateText("7051", "раз");
    await privateText("7052", "два");
    await receivedSecondsAgo(3, "7051", "7052");
    const head = await telegramIngressRepository.claimNext(LEASE, BURST);

    await telegramIngressRepository.fail(head!.updateId, head!.leaseToken, {
      code: "AGENT_TELEGRAM_INGRESS_FAILED", message: "Не удалось обработать сообщение Telegram",
    });

    expect(await statusOf("7052")).toBe("failed");
  });

  it("keeps a handed-off burst fixed and starts the next burst with a later message", async () => {
    await privateText("7061", "первое");
    await privateText("7062", "второе");
    await receivedSecondsAgo(3, "7061", "7062");
    const head = await telegramIngressRepository.claimNext(LEASE, BURST);
    await telegramIngressRepository.beginDispatch(head!.updateId, head!.leaseToken, crypto.randomUUID());
    await privateText("7063", "пришло во время ответа");
    await receivedSecondsAgo(3, "7063");
    await database().query("UPDATE telegram_ingress_updates SET lease_expires_at = now() - interval '1 second' WHERE update_id = 7061");

    const recovered = await telegramIngressRepository.claimNext(LEASE, BURST);
    expect(recovered?.updateId).toBe("7061");
    expect(burstIds(recovered?.burstPayloads)).toEqual([7061, 7062]);
    await telegramIngressRepository.complete(recovered!.updateId, recovered!.leaseToken);

    const next = await telegramIngressRepository.claimNext(LEASE, BURST);
    expect(next?.updateId).toBe("7063");
    expect(next?.burstPayloads).toBeUndefined();
  });

  it("holds a steady stream no longer than the cap, then takes all of it", async () => {
    await privateText("7101", "первое");
    await privateText("7102", "ещё пишу");
    await receivedSecondsAgo(25, "7101");

    const head = await telegramIngressRepository.claimNext(LEASE, BURST);
    expect(burstIds(head?.burstPayloads)).toEqual([7101, 7102]);
  });

  it("never holds a button press or a group message", async () => {
    await privateButton("7201");
    expect((await telegramIngressRepository.claimNext(LEASE, BURST))?.updateId).toBe("7201");

    await telegramIngressRepository.enqueue({
      continuationKey: "telegram:group:-500",
      payload: {
        message: { chat: { id: -500, type: "supergroup" }, date: 1_700_000_000, from: { first_name: "Анна", id: 101, is_bot: false }, message_id: 1, text: "всем привет" },
        update_id: 7202,
      },
      updateId: "7202",
    });
    expect((await telegramIngressRepository.claimNext(LEASE, BURST))?.updateId).toBe("7202");
  });

  it("ends the burst at a button press, which does not extend the wait", async () => {
    await privateText("7301", "подтверди");
    await privateButton("7302");
    await receivedSecondsAgo(3, "7301");

    const head = await telegramIngressRepository.claimNext(LEASE, BURST);
    expect(head?.updateId).toBe("7301");
    expect(head?.burstPayloads).toBeUndefined();
  });

  it("claims at once without a quiet window", async () => {
    await privateText("7401", "сразу");
    expect((await telegramIngressRepository.claimNext(LEASE, { ...BURST, maxWaitMilliseconds: 0, quietMilliseconds: 0 }))?.updateId)
      .toBe("7401");
  });
});
