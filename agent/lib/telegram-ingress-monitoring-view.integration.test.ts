/**
 * Ingress queue monitoring view integration test.
 *
 * The queue is strictly ordered per chat, so a long turn keeps its own chat's later messages
 * waiting, and in a group most of those are chatter that is only journaled. The raw age of the
 * oldest waiting message counted them and paged the owner about a silent assistant while every
 * other chat was answered (#272). The view therefore separates two questions:
 *
 * - `stalled_oldest_age_seconds`: how long a message has waited in a chat where nothing is running.
 *   Only a dead worker, a blocked queue or a full set of processing slots produces it.
 * - `longest_running_seconds`: how long the longest turn in progress has been running.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { telegramIngressRepository } from "./telegram-ingress-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

// Ages are computed from now() when the view is read, so a slow statement may add a second or two.
const AGE_TOLERANCE_SECONDS = 5;

async function enqueue(chatId: number, updateId: number, receivedSecondsAgo: number): Promise<void> {
  await telegramIngressRepository.enqueue({
    continuationKey: `${chatId}::`,
    payload: { update_id: updateId, message: {
      message_id: updateId, date: 1_700_000_000,
      chat: { id: chatId, type: "supergroup" },
      from: { id: 101, first_name: "User", is_bot: false },
      text: `message ${updateId}`,
    } },
    updateId: String(updateId),
  });
  await database().query(
    "UPDATE telegram_ingress_updates SET received_at = now() - $2 * interval '1 second' WHERE update_id = $1",
    [updateId, receivedSecondsAgo],
  );
}

/** A claimed message whose worker keeps the lease alive and has started the turn. */
async function markRunning(updateId: number, runningSecondsAgo: number): Promise<void> {
  await database().query(
    `UPDATE telegram_ingress_updates
        SET status = 'processing', lease_token = gen_random_uuid(),
            lease_expires_at = now() + interval '1 minute',
            dispatch_started_at = now() - $2 * interval '1 second', dispatch_id = gen_random_uuid()
      WHERE update_id = $1`,
    [updateId, runningSecondsAgo],
  );
}

/** A claimed message still waiting for a free processing slot: the turn has not started. */
async function markClaimedWaitingForSlot(updateId: number): Promise<void> {
  await database().query(
    `UPDATE telegram_ingress_updates
        SET status = 'processing', lease_token = gen_random_uuid(),
            lease_expires_at = now() + interval '1 minute'
      WHERE update_id = $1`,
    [updateId],
  );
}

/** A started turn whose worker died: nobody renews the lease any more. */
async function markLeaseLost(updateId: number, startedSecondsAgo: number): Promise<void> {
  await database().query(
    `UPDATE telegram_ingress_updates
        SET status = 'processing', lease_token = gen_random_uuid(),
            lease_expires_at = now() - interval '1 minute',
            dispatch_started_at = now() - $2 * interval '1 second', dispatch_id = gen_random_uuid()
      WHERE update_id = $1`,
    [updateId, startedSecondsAgo],
  );
}

async function readView() {
  const result = await database().query<{
    longest_running_seconds: string;
    stalled_oldest_age_seconds: string;
  }>("SELECT stalled_oldest_age_seconds, longest_running_seconds FROM monitoring_telegram_ingress");
  expect(result.rowCount).toBe(1);
  return {
    running: Number(result.rows[0]!.longest_running_seconds),
    stalled: Number(result.rows[0]!.stalled_oldest_age_seconds),
  };
}

function expectAge(actual: number, expected: number): void {
  expect(actual).toBeGreaterThanOrEqual(expected);
  expect(actual).toBeLessThan(expected + AGE_TOLERANCE_SECONDS);
}

describeWithDatabase("ingress queue monitoring view", () => {
  // The view aggregates the whole table, so rows left by a neighbouring file would shift every age.
  beforeEach(async () => { await database().query("TRUNCATE telegram_ingress_queues CASCADE"); });
  afterAll(closeDatabase);

  it("answers zeros when the queue is empty", async () => {
    // A metric that disappears with an empty queue reads the same as one that is not collected.
    expect(await readView()).toEqual({ running: 0, stalled: 0 });
  });

  it("does not report a chat waiting behind its own running turn as stalled", async () => {
    await enqueue(-1001, 1, 1_500);
    await enqueue(-1001, 2, 1_200);
    await enqueue(-1001, 3, 600);
    await markRunning(1, 1_380);

    const view = await readView();

    expect(view.stalled).toBe(0);
    expectAge(view.running, 1_380);
  });

  it("reports a message in a chat where nothing runs, next to a busy chat", async () => {
    await enqueue(-1001, 1, 1_500);
    await enqueue(-1001, 2, 1_200);
    await markRunning(1, 1_380);
    await enqueue(-1002, 10, 660);

    const view = await readView();

    // The busy chat holds the older message, yet only the idle chat's wait counts.
    expectAge(view.stalled, 660);
    expectAge(view.running, 1_380);
  });

  it("counts a claimed message still waiting for a processing slot as unserved", async () => {
    await enqueue(-1003, 20, 700);
    await markClaimedWaitingForSlot(20);

    const view = await readView();

    expectAge(view.stalled, 700);
    expect(view.running).toBe(0);
  });

  it("treats a turn whose worker lost the lease as unserved, not as running", async () => {
    await enqueue(-1004, 30, 900);
    await enqueue(-1004, 31, 300);
    await markLeaseLost(30, 880);

    const view = await readView();

    expectAge(view.stalled, 900);
    expect(view.running).toBe(0);
  });

  it("counts messages behind a queue blocked by an unconfirmed cancellation as unserved", async () => {
    await enqueue(-1005, 40, 1_000);
    await enqueue(-1005, 41, 800);
    // The claim refuses every later message of the chat until this row is recovered.
    await database().query(
      `UPDATE telegram_ingress_updates
          SET status = 'failed', completed_at = now(),
              last_error_code = 'AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED',
              last_error_message = 'cancellation was not confirmed'
        WHERE update_id = 40`,
    );

    const view = await readView();

    expectAge(view.stalled, 800);
    expect(view.running).toBe(0);
  });

  it("reports the longest of several turns running at once", async () => {
    await enqueue(-1001, 1, 400);
    await markRunning(1, 380);
    await enqueue(-1002, 10, 1_300);
    await markRunning(10, 1_250);

    expectAge((await readView()).running, 1_250);
  });
});
