/**
 * Reply button persistence integration tests.
 *
 * Constructs covered:
 * - One staged set per turn: a second call of the tool replaces the first.
 * - A turn that continues after an approval finds the buttons its parked turn staged.
 * - A press is claimed once, by the addressee, in the set's own chat and message; the same callback
 *   finds its claim again after a crash; anyone else is refused without consuming it.
 * - A set whose message went out before its number was saved still accepts its press.
 * - The addressee's message dismisses only the sets they could tap before writing it.
 * - A reminder's set carries its text and formatting entities.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { newTurnId } from "../../runtime/ids.js";
import { createTurn, inJournalTransaction } from "../../runtime/turn/journal-repository.js";
import { newTestSession, OWNER_AUTH, startMessageTurn } from "../../runtime/turn/turn.integration-fixtures.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { replyButtonRepository } from "./reply-button-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
const describeWithDatabase = enabled ? describe : describe.skip;

const ROWS = [[{ color: "green" as const, text: "✅ Да" }, { text: "❌ Нет" }]];
const TARGET = { addresseeTelegramUserId: "101", telegramChatId: "101", telegramChatType: "private" as const };
const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";

async function stageTurn(turnId: string, token: string = TOKEN) {
  await replyButtonRepository.stageForTurn({ ...TARGET, agentSessionId: "wrun_1", agentTurnId: turnId, buttons: ROWS, token });
  const set = await replyButtonRepository.findStagedForTurn(turnId);
  if (set === null) throw new Error("TEST_SET_MISSING");
  return set;
}

async function delivered(turnId: string, messageId: string, token: string = TOKEN) {
  const set = await stageTurn(turnId, token);
  await replyButtonRepository.recordMessageText(set.id, "Берём?", "plain");
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
    await database().query("TRUNCATE telegram_reply_button_sets, conversation_session_routes, conversation_sessions, family_memberships, users, families CASCADE");
  });
  afterAll(closeDatabase);

  it("keeps one staged set per turn, the last one the tool wrote", async () => {
    await stageTurn("turn_1", "A".repeat(22));
    const replaced = await stageTurn("turn_1", "B".repeat(22));

    expect(replaced).toMatchObject({ buttons: ROWS, token: "B".repeat(22) });
    expect((await database().query("SELECT 1 FROM telegram_reply_button_sets")).rowCount).toBe(1);
  });

  it("finds buttons the parked turn staged from the turn that continues it", async () => {
    const sessionId = await newTestSession();
    const parked = await startMessageTurn(sessionId, "оформи заказ");
    const continuation = await inJournalTransaction(database(), async (client) => await createTurn(client, {
      auth: OWNER_AUTH, channel: parked.channel, id: newTurnId(),
      input: { context: [] }, kind: "conversation", parent: null, resumesTurnId: parked.id, sessionId,
    }));
    await stageTurn(parked.id);

    await expect(replyButtonRepository.findStagedForTurn(continuation.id)).resolves.toMatchObject({ token: TOKEN });
    await expect(replyButtonRepository.findStagedForTurn("turn_unrelated")).resolves.toBeNull();
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
    await replyButtonRepository.recordMessageText(set.id, "Берём?", "plain");

    await expect(pressOf()).resolves.toMatchObject({ set: { telegramMessageId: "50" }, status: "claimed" });
    await replyButtonRepository.activate(set.id, "50");
    expect((await database().query("SELECT status FROM telegram_reply_button_sets")).rows).toEqual([{ status: "selected" }]);
  });

  it("refuses a press on buttons that never went out", async () => {
    await stageTurn("turn_1");

    await expect(pressOf()).resolves.toEqual({ status: "expired" });
  });

  it("dismisses only the addressee's buttons offered before their message", async () => {
    const before = await delivered("turn_1", "50", "A".repeat(22));
    await replyButtonRepository.stageForTurn({ ...TARGET, addresseeTelegramUserId: "202", agentSessionId: "wrun_1",
      agentTurnId: "turn_2", buttons: ROWS, token: "B".repeat(22) });
    const other = (await replyButtonRepository.findStagedForTurn("turn_2"))!;
    await replyButtonRepository.recordMessageText(other.id, "Берём?", "plain");
    await replyButtonRepository.activate(other.id, "51");
    const writtenAt = new Date(Date.now() + 1_000);
    const after = await stageTurn("turn_3", "C".repeat(22));
    await replyButtonRepository.recordMessageText(after.id, "Ещё?", "plain");
    await database().query("UPDATE telegram_reply_button_sets SET status = 'active', telegram_message_id = 52, activated_at = $2 WHERE id = $1",
      [after.id, new Date(writtenAt.getTime() + 1_000)]);

    const dismissed = await replyButtonRepository.dismissForAddressee({ addresseeTelegramUserId: "101", telegramChatId: "101", writtenAt });

    expect(dismissed.map((set) => set.id)).toEqual([before.id]);
    expect(dismissed[0]).toMatchObject({ messageText: "Берём?", telegramMessageId: "50" });
    const statuses = (await database().query<{ id: string; status: string }>("SELECT id, status FROM telegram_reply_button_sets")).rows;
    expect(Object.fromEntries(statuses.map((row) => [row.id, row.status]))).toEqual({
      [before.id]: "dismissed", [other.id]: "active", [after.id]: "active",
    });
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

  it("stages a reminder's buttons with its text and entities", async () => {
    const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Кнопки') RETURNING id");
    const user = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('101', 'Владелец') RETURNING id");
    const reminder = await database().query<{ id: string }>(
      `INSERT INTO reminders (family_id, owner_user_id, author_user_id, scope, content, timezone, telegram_chat_id,
         recurrence_anchor_local, due_at, available_at)
       VALUES ($1, $2, $2, 'personal', 'Оплатить интернет', 'Europe/Moscow', '101', now(), now(), now()) RETURNING id`,
      [family.rows[0]!.id, user.rows[0]!.id]);

    const set = await replyButtonRepository.stageForReminder({
      ...TARGET, buttons: ROWS, messageEntities: [{ length: 14, offset: 0, type: "bold" }],
      messageText: "⏰ Напоминание:\n\nОплатить интернет", reminderId: reminder.rows[0]!.id, token: TOKEN,
    });
    await replyButtonRepository.activate(set.id, "70");

    expect(set).toMatchObject({ messageEntities: [{ length: 14, offset: 0, type: "bold" }], messageFormat: "plain" });
    await expect(pressOf({ telegramMessageId: "70" })).resolves.toMatchObject({ status: "claimed" });
  });
});
