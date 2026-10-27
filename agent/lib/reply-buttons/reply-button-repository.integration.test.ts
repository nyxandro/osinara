/**
 * Reply button persistence integration tests.
 *
 * Constructs covered:
 * - One staged set per turn: a replay of its delivery finds it again with the same token and
 *   records the text of the message once more.
 * - A press is claimed once, by the addressee, in the set's own chat and message; the same callback
 *   finds its claim again after a crash; anyone else is refused without consuming it.
 * - A set whose message went out before its number was saved still accepts its press.
 * - The addressee's message dismisses only the sets they could tap before writing it, and leaves a
 *   set whose tap arrived earlier and still waits to be decided.
 * - A reminder's set carries its text.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { replyButtonRepository } from "./reply-button-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
const describeWithDatabase = enabled ? describe : describe.skip;

const ROWS = [[{ color: "green" as const, text: "✅ Да" }, { text: "❌ Нет" }]];
const TARGET = { addresseeTelegramUserId: "101", telegramChatId: "101", telegramChatType: "private" as const };
const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";

async function stageTurn(turnId: string, token: string = TOKEN, target = TARGET, messageText = "Берём?") {
  return await replyButtonRepository.stageForTurn({
    ...target, agentSessionId: "wrun_1", agentTurnId: turnId, buttons: ROWS, messageText, token,
  });
}

async function delivered(turnId: string, messageId: string, token: string = TOKEN) {
  const set = await stageTurn(turnId, token);
  await replyButtonRepository.activate(set.id, messageId);
  return set;
}

function pressOf(overrides: Partial<Parameters<typeof replyButtonRepository.claimPress>[0]> = {}) {
  return replyButtonRepository.claimPress({
    callbackQueryId: "cb-1", index: 0, pressedByTelegramUserId: "101",
    telegramChatId: "101", telegramMessageId: "50", token: TOKEN, ...overrides,
  });
}

describeWithDatabase("reply button repository", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE telegram_reply_button_sets, telegram_ingress_updates, telegram_ingress_queues, conversation_session_routes, conversation_sessions, family_memberships, users, families CASCADE");
  });
  afterAll(closeDatabase);

  it("keeps one staged set per turn and its token when the delivery is replayed", async () => {
    const first = await stageTurn("turn_1", "A".repeat(22), TARGET, "Берём?");
    const replayed = await stageTurn("turn_1", "B".repeat(22), TARGET, "Берём пиццу?");

    expect(replayed).toMatchObject({ buttons: ROWS, id: first.id, messageText: "Берём пиццу?", token: "A".repeat(22) });
    expect((await database().query("SELECT message_format FROM telegram_reply_button_sets")).rows).toEqual([
      { message_format: "rich" },
    ]);
  });

  it("activates a turn's staged buttons under its last message", async () => {
    await stageTurn("turn_1");

    await replyButtonRepository.activateForTurn("turn_1", "50");
    await replyButtonRepository.activateForTurn("turn_1", "52");
    await replyButtonRepository.activateForTurn("turn_unrelated", "51");

    expect((await database().query("SELECT status, telegram_message_id::text FROM telegram_reply_button_sets")).rows)
      .toEqual([{ status: "active", telegram_message_id: "50" }]);
  });

  it("discards only buttons that never went out", async () => {
    const refused = await stageTurn("turn_1", "A".repeat(22));
    const offered = await delivered("turn_2", "51", "B".repeat(22));

    await replyButtonRepository.discard(refused.id);
    await replyButtonRepository.discard(offered.id);

    expect((await database().query("SELECT id FROM telegram_reply_button_sets")).rows).toEqual([{ id: offered.id }]);
  });

  it("claims a press once and finds the same claim for the same callback", async () => {
    await delivered("turn_1", "50");

    const first = await pressOf();
    const replay = await pressOf();
    const second = await pressOf({ callbackQueryId: "cb-2", index: 1 });

    expect(first).toMatchObject({ set: { selectedIndex: 0, telegramMessageId: "50" }, status: "claimed" });
    expect(replay).toMatchObject({ set: { selectedIndex: 0 }, status: "replayed" });
    expect(second).toMatchObject({ decided: { selectedIndex: 0, status: "selected" }, status: "expired" });
  });

  it("refuses anyone but the addressee without consuming the buttons", async () => {
    await delivered("turn_1", "50");

    await expect(pressOf({ pressedByTelegramUserId: "202" })).resolves.toEqual({ status: "forbidden" });
    await expect(pressOf()).resolves.toMatchObject({ status: "claimed" });
  });

  it("refuses a press from another chat, another message or a button out of range", async () => {
    await delivered("turn_1", "50");

    await expect(pressOf({ telegramChatId: "999" })).resolves.toEqual({ status: "expired" });
    await expect(pressOf({ telegramMessageId: "51" })).resolves.toEqual({ status: "expired" });
    await expect(pressOf({ index: 5 })).resolves.toEqual({ status: "expired" });
  });

  it("accepts a press on a message whose number was not saved yet and binds it", async () => {
    const set = await stageTurn("turn_1");

    await expect(pressOf()).resolves.toMatchObject({ set: { telegramMessageId: "50" }, status: "claimed" });
    await replyButtonRepository.activate(set.id, "50");
    expect((await database().query("SELECT status FROM telegram_reply_button_sets")).rows).toEqual([{ status: "selected" }]);
  });

  it("dismisses only the addressee's buttons offered before their message", async () => {
    const before = await delivered("turn_1", "50", "A".repeat(22));
    const other = await stageTurn("turn_2", "B".repeat(22), { ...TARGET, addresseeTelegramUserId: "202" });
    await replyButtonRepository.activate(other.id, "51");
    const writtenAt = new Date(Date.now() + 1_000);
    const after = await stageTurn("turn_3", "C".repeat(22), TARGET, "Ещё?");
    await database().query("UPDATE telegram_reply_button_sets SET status = 'active', telegram_message_id = 52, activated_at = $2 WHERE id = $1",
      [after.id, new Date(writtenAt.getTime() + 1_000)]);

    const dismissed = await replyButtonRepository.dismissForAddressee({
      addresseeTelegramUserId: "101", afterUpdateId: "9000", telegramChatId: "101", writtenAt,
    });

    expect(dismissed.map((set) => set.id)).toEqual([before.id]);
    expect(dismissed[0]).toMatchObject({ messageText: "Берём?", telegramMessageId: "50" });
    const statuses = (await database().query<{ id: string; status: string }>("SELECT id, status FROM telegram_reply_button_sets")).rows;
    expect(Object.fromEntries(statuses.map((row) => [row.id, row.status]))).toEqual({
      [before.id]: "dismissed", [other.id]: "active", [after.id]: "active",
    });
  });

  it("leaves buttons whose earlier tap still waits to be decided", async () => {
    const tapped = await delivered("turn_1", "50", "A".repeat(22));
    const untouched = await delivered("turn_2", "51", "B".repeat(22));
    const queue = await database().query<{ id: string }>(
      "INSERT INTO telegram_ingress_queues (current_continuation_key) VALUES ('101::') RETURNING id");
    await database().query(
      `INSERT INTO telegram_ingress_updates (update_id, queue_id, ingress_continuation_key, payload, status)
       VALUES (8999, $1, '101::', $2::jsonb, 'pending'), (9001, $1, '101::', $3::jsonb, 'pending')`,
      [queue.rows[0]!.id, JSON.stringify({ callback_query: { data: `rb:${"A".repeat(22)}:0`, from: { id: 101 } }, update_id: 8999 }),
        JSON.stringify({ callback_query: { data: `rb:${"B".repeat(22)}:0`, from: { id: 101 } }, update_id: 9001 })],
    );

    const dismissed = await replyButtonRepository.dismissForAddressee({
      addresseeTelegramUserId: "101", afterUpdateId: "9000", telegramChatId: "101", writtenAt: new Date(Date.now() + 1_000),
    });

    // The tap on B came after the message, so B goes; the tap on A came first and keeps A.
    expect(dismissed.map((set) => set.id)).toEqual([untouched.id]);
    await expect(pressOf({ telegramMessageId: "50", token: tapped.token })).resolves.toMatchObject({ status: "claimed" });
  });

  it("does not let another member's earlier tap keep the addressee's buttons", async () => {
    const offered = await delivered("turn_1", "50", "A".repeat(22));
    const queue = await database().query<{ id: string }>(
      "INSERT INTO telegram_ingress_queues (current_continuation_key) VALUES ('101::') RETURNING id");
    await database().query(
      `INSERT INTO telegram_ingress_updates (update_id, queue_id, ingress_continuation_key, payload, status)
       VALUES (8999, $1, '101::', $2::jsonb, 'pending')`,
      [queue.rows[0]!.id, JSON.stringify({ callback_query: { data: `rb:${"A".repeat(22)}:0`, from: { id: 202 } }, update_id: 8999 })],
    );
    await expect(replyButtonRepository.hasActiveForAddressee({ addresseeTelegramUserId: "101", telegramChatId: "101" }))
      .resolves.toBe(true);

    const dismissed = await replyButtonRepository.dismissForAddressee({
      addresseeTelegramUserId: "101", afterUpdateId: "9000", telegramChatId: "101", writtenAt: new Date(Date.now() + 1_000),
    });

    expect(dismissed.map((set) => set.id)).toEqual([offered.id]);
    await expect(replyButtonRepository.hasActiveForAddressee({ addresseeTelegramUserId: "101", telegramChatId: "101" }))
      .resolves.toBe(false);
  });

  it("treats a reply route as open only into a live conversation that waits for no approval", async () => {
    const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Маршруты') RETURNING id");
    const user = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('101', 'Владелец') RETURNING id");
    await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [family.rows[0]!.id, user.rows[0]!.id]);
    const session = await sessionRepository.prepareTurn({
      baseContinuationToken: "101::", familyId: family.rows[0]!.id, groupId: null, kind: "canonical", now: new Date(),
      scope: "personal", telegramForumTopicId: null, userId: user.rows[0]!.id,
    });
    await sessionRepository.registerRouteAlias(session.id, "101::50");

    await expect(replyButtonRepository.replyRouteIsOpen("101::50")).resolves.toBe(true);
    await expect(replyButtonRepository.replyRouteIsOpen("101::51")).resolves.toBe(false);
    await sessionRepository.parkSession({
      applicationSessionId: session.id, pendingRequestId: "approval-1", requesterTelegramUserId: "101",
      requesterUserId: user.rows[0]!.id,
    });
    await expect(replyButtonRepository.replyRouteIsOpen("101::50")).resolves.toBe(false);
  });

  it("stages a reminder's buttons with its text", async () => {
    const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Кнопки') RETURNING id");
    const user = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('101', 'Владелец') RETURNING id");
    const reminder = await database().query<{ id: string }>(
      `INSERT INTO reminders (family_id, owner_user_id, author_user_id, scope, content, timezone, telegram_chat_id,
         recurrence_anchor_local, due_at, available_at)
       VALUES ($1, $2, $2, 'personal', 'Оплатить интернет', 'Europe/Moscow', '101', now(), now(), now()) RETURNING id`,
      [family.rows[0]!.id, user.rows[0]!.id]);

    const set = await replyButtonRepository.stageForReminder({
      ...TARGET, buttons: ROWS, messageText: "**⏰ Напоминание:**\n\n<p>Оплатить интернет</p>",
      reminderId: reminder.rows[0]!.id, token: TOKEN,
    });
    await replyButtonRepository.activate(set.id, "70");

    expect(set).toMatchObject({ messageText: "**⏰ Напоминание:**\n\n<p>Оплатить интернет</p>", status: "staged" });
    await expect(pressOf({ telegramMessageId: "70" })).resolves.toMatchObject({ status: "claimed" });
  });
});
