/**
 * PostgreSQL integration tests for private-chat message bursts.
 *
 * Constructs covered:
 * - A private chat's head waits until the chat has been quiet for the window, then is claimed.
 * - A steady stream waits at most the cap; buttons, groups and recoveries are never held.
 * - The drain learns exactly when the next held chat becomes ready, and nothing when none is held.
 * - A message knows whether another message of its chat already waits behind it; a button press
 *   or a message that could not start a turn itself ends the burst.
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
const BURST = { maxWaitMilliseconds: 20_000, quietMilliseconds: 2_000 };
const PRIVATE = "telegram:private:101";

async function privateText(updateId: string, text: string) {
  await telegramIngressRepository.enqueue({
    continuationKey: PRIVATE,
    payload: {
      message: { chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false }, message_id: Number(updateId), text },
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
        chat_instance: "101", data: "eve:1", from: { id: 101, is_bot: false }, id: `callback-${updateId}`,
        message: { chat: { id: 101, type: "private" }, from: { id: 900, is_bot: true }, message_id: 1 },
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

async function finish(updateId: string) {
  const claim = await telegramIngressRepository.claimNext(LEASE, BURST);
  expect(claim?.updateId).toBe(updateId);
  await telegramIngressRepository.complete(claim!.updateId, claim!.leaseToken);
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

  it("waits until the chat is quiet for the window, then claims the burst in order", async () => {
    await privateText("7001", "вот такой ответ ты прислала");
    await privateText("7002", "мне не нравится");
    await receivedSecondsAgo(5, "7001");

    // The newest message is fresh, so the chat may still be typing.
    expect(await telegramIngressRepository.claimNext(LEASE, BURST)).toBeNull();
    const readyIn = await telegramPrivateBurstRepository.readyInMilliseconds(BURST);
    expect(readyIn).toBeGreaterThan(0);
    expect(readyIn).toBeLessThanOrEqual(2_000);

    await receivedSecondsAgo(3, "7002");
    expect(await telegramPrivateBurstRepository.readyInMilliseconds(BURST)).toBeNull();
    const head = await telegramIngressRepository.claimNext(LEASE, BURST);
    expect(head?.updateId).toBe("7001");
    expect(await telegramPrivateBurstRepository.hasFollowingMessage("7001")).toBe(true);
    await telegramIngressRepository.complete(head!.updateId, head!.leaseToken);

    expect(await telegramPrivateBurstRepository.hasFollowingMessage("7002")).toBe(false);
    await finish("7002");
  });

  it("holds a steady stream no longer than the cap", async () => {
    await privateText("7101", "первое");
    await privateText("7102", "ещё пишу");
    await receivedSecondsAgo(25, "7101");

    expect((await telegramIngressRepository.claimNext(LEASE, BURST))?.updateId).toBe("7101");
  });

  it("never holds a button press or a group message", async () => {
    await privateButton("7201");
    expect((await telegramIngressRepository.claimNext(LEASE, BURST))?.updateId).toBe("7201");

    await telegramIngressRepository.enqueue({
      continuationKey: "telegram:group:-500",
      payload: {
        message: { chat: { id: -500, type: "supergroup" }, from: { id: 101, is_bot: false }, message_id: 1, text: "всем привет" },
        update_id: 7202,
      },
      updateId: "7202",
    });
    expect((await telegramIngressRepository.claimNext(LEASE, BURST))?.updateId).toBe("7202");
  });

  it("ends the burst at a button press behind the message", async () => {
    await privateText("7301", "подтверди");
    await privateButton("7302");
    await receivedSecondsAgo(3, "7301", "7302");

    const head = await telegramIngressRepository.claimNext(LEASE, BURST);
    expect(head?.updateId).toBe("7301");
    expect(await telegramPrivateBurstRepository.hasFollowingMessage("7301")).toBe(false);
  });

  it("ends the burst at a message that could not start a turn itself", async () => {
    await privateText("7501", "смотри");
    await telegramIngressRepository.enqueue({
      continuationKey: PRIVATE,
      payload: {
        message: { chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false }, message_id: 7502, sticker: { file_id: "sticker-1" } },
        update_id: 7502,
      },
      updateId: "7502",
    });

    expect(await telegramPrivateBurstRepository.hasFollowingMessage("7501")).toBe(false);
  });

  it("claims at once without a window, as the tests of other behavior expect", async () => {
    await privateText("7401", "сразу");
    expect((await telegramIngressRepository.claimNext(LEASE, { maxWaitMilliseconds: 0, quietMilliseconds: 0 }))?.updateId)
      .toBe("7401");
  });
});
