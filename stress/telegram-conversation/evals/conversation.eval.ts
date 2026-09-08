/** Full webhook -> durable queue -> native Eve -> sandbox -> model -> Telegram, through rotation. */
import assert from "node:assert/strict";
import { defineEval } from "eve/evals";
import { database, closeDatabase } from "../../../agent/lib/database.js";
import { SESSION_MAX_COMPLETED_TURNS } from "../../../agent/config.js";

export default defineEval({
  timeoutMs: 240_000,
  async test(t) {
    assert.equal(process.env.RUN_DATABASE_INTEGRATION_TESTS, "true");
    assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/osinara_test");
    const db = database();
    await db.query("TRUNCATE users, families CASCADE");
    const family = (await db.query<{ id: string }>("INSERT INTO families(name) VALUES ('Telegram conversation test') RETURNING id")).rows[0]!;
    const chatId = -900_000_101;
    const familyChatId = -900_000_102;
    const turnCount = SESSION_MAX_COMPLETED_TURNS + 4;
    const failingOrdinal = SESSION_MAX_COMPLETED_TURNS + 3;
    const cursors = new Map<string, number>();
    try {
      await db.query(`CREATE TABLE telegram_conversation_test_deliveries (
        id integer GENERATED ALWAYS AS IDENTITY (START WITH 10000), body jsonb NOT NULL)`);
      await db.query("CREATE TABLE telegram_conversation_test_sandboxes (eve_session_id text NOT NULL, mounts jsonb NOT NULL)");
      await db.query("CREATE TABLE telegram_conversation_test_model_calls (marker text NOT NULL)");
      const owner = (await db.query<{ id: string }>("INSERT INTO users(telegram_user_id,display_name) VALUES('902','Human') RETURNING id")).rows[0]!;
      await db.query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')", [family.id, owner.id]);
      await db.query("INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode) VALUES($1,$2,'Family test','family_private','all')", [family.id, String(familyChatId)]);
      const group = (await db.query<{ id: string }>(
        `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode, skill_allowlist, tool_allowlist)
         VALUES ($1, $2, 'BotBattle test', 'external', 'all', ARRAY['pohuy'], ARRAY['remember','bash']) RETURNING id`,
        [family.id, String(chatId)],
      )).rows[0]!;
      for (let ordinal = 1; ordinal <= turnCount + 2; ordinal += 1) {
        const marker = `conversation-probe-${ordinal}`;
        const isBot = ordinal <= turnCount && ordinal % 2 === 1;
        const currentChatId = ordinal <= turnCount ? chatId : ordinal === turnCount + 1 ? 902 : familyChatId;
        const message = {
          message_id: ordinal,
          chat: { id: currentChatId, type: currentChatId > 0 ? "private" : "supergroup", title: "Conversation test" },
          date: Math.floor(Date.now() / 1_000),
          from: { id: isBot ? 901 : 902, first_name: isBot ? "Peer bot" : "Human", is_bot: isBot },
          ...(ordinal <= turnCount ? { reply_to_message: {
            message_id: 9000,
            chat: { id: chatId, type: "supergroup" },
            date: Math.floor(Date.now() / 1_000),
            from: { id: 903, is_bot: true, first_name: "Other bot", username: "other_bot" },
            text: "Previous participant message",
          } } : {}),
          ...(ordinal % 3 === 0
            ? { rich_message: { blocks: [{ type: "paragraph", text: `@osinara_bot ${marker}` }] } }
            : { text: `@osinara_bot ${marker}` }),
        };
        const response = await t.target.fetch("/eve/v1/telegram", {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": "conversation-test-secret" },
          body: JSON.stringify({ update_id: 900_000_000 + ordinal, message }),
        });
        assert.equal(response.status, 200);
        let completed = false;
        for (let poll = 0; poll < 150; poll += 1) {
          const result = await db.query<{ status: string; eve_session_id: string | null; last_error_code: string | null }>(
            "SELECT status,eve_session_id,last_error_code FROM telegram_ingress_updates WHERE update_id = $1",
            [900_000_000 + ordinal],
          );
          const row = result.rows[0];
          if (row?.status === "failed") throw new Error(`TEST_INGRESS_FAILED: ${row.last_error_code}`);
          if (row?.status === "completed") {
            assert.ok(row.eve_session_id, `No Eve turn for ${marker}`);
            const session = await t.target.attachSession(row.eve_session_id, { startIndex: cursors.get(row.eve_session_id) ?? 0 });
            if (ordinal === failingOrdinal) {
              session.event("turn.failed");
              session.event("session.waiting");
            } else {
              session.succeeded();
              session.messageIncludes(`reply-${marker}`);
              session.calledTool("probe_workspace");
              session.calledTool("bash");
              if (ordinal === 1 || ordinal === SESSION_MAX_COMPLETED_TURNS + 1 || ordinal > turnCount) {
                session.loadedSkill("pohuy");
                session.calledSubagent("agent");
              }
            }
            const cursor = (await db.query<{ next_event_index: number }>(
              "SELECT next_event_index FROM eve_session_event_cursors WHERE eve_session_id = $1", [row.eve_session_id],
            )).rows[0]!;
            cursors.set(row.eve_session_id, Number(cursor.next_event_index));
            completed = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(completed, `Conversation stalled at ${marker}`);
      }
      const sessions = (await db.query<{ completed_turns: number; generation: number }>(
        "SELECT completed_turns,generation FROM conversation_sessions WHERE group_id=$1 ORDER BY generation", [group.id],
      )).rows;
      assert.deepEqual(sessions.map((s) => s.completed_turns), [SESSION_MAX_COMPLETED_TURNS, 3]);
      assert.equal((await db.query("SELECT DISTINCT eve_session_id FROM telegram_conversation_test_sandboxes")).rowCount, 4);
      assert.equal((await db.query("SELECT 1 FROM memory_review_owner_alerts WHERE family_id=$1", [family.id])).rowCount, 0);
      const deliveries = (await db.query<{ body: { text: string; reply_parameters?: { message_id: number } } }>(
        "SELECT body FROM telegram_conversation_test_deliveries",
      )).rows;
      const notices = deliveries.filter((d) => !d.body.text.startsWith("reply-conversation-probe-"));
      assert.equal(notices.length, 2);
      assert.equal(notices.filter((d) => d.body.text.startsWith("AGENT_PROFILE_PROJECTION_POLICY_NOTICE:")).length, 1);
      assert.equal(notices.filter((d) => d.body.text === "Нейросеть сейчас недоступна.\n\nПопробуйте повторить запрос чуть позже." &&
        d.body.reply_parameters?.message_id === failingOrdinal).length, 1);
      assert.equal(deliveries.length - notices.length, turnCount + 1);
      for (let ordinal = 1; ordinal <= turnCount + 2; ordinal += 1) {
        const replies = deliveries.filter((d) => JSON.stringify(d.body).includes(`reply-conversation-probe-${ordinal}\"`));
        assert.equal(replies.length, ordinal === failingOrdinal ? 0 : 1, `Delivery count for turn ${ordinal}`);
      }
      t.log(`verified ${turnCount + 2} turns, 4 sessions, all chat modes, granted skills, Bash, native subagents, rotation and recovery`);

      // Inject a real PostgreSQL error in the mandatory native turn.started preparation.
      // The model ledger proves that optional adapter-error handling cannot let the provider run.
      assert.ok((await db.query("SELECT 1 FROM telegram_conversation_test_model_calls LIMIT 1")).rowCount);
      await db.query(`CREATE FUNCTION telegram_test_reject_binding() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'TEST_REQUIRED_PREPARATION_FAILED'; END $$`);
      await db.query(`CREATE TRIGGER telegram_test_reject_binding BEFORE UPDATE OF eve_session_id
        ON conversation_sessions FOR EACH ROW EXECUTE FUNCTION telegram_test_reject_binding()`);
      const preparationOrdinal = turnCount + 3;
      const response = await t.target.fetch("/eve/v1/telegram", {
        method: "POST", headers: { "x-telegram-bot-api-secret-token": "conversation-test-secret" },
        body: JSON.stringify({ update_id: 900_000_000 + preparationOrdinal, message: {
          message_id: preparationOrdinal, date: Math.floor(Date.now() / 1000),
          chat: { id: familyChatId, type: "supergroup" }, from: { id: 902, first_name: "Human", is_bot: false },
          text: `@osinara_bot conversation-probe-${preparationOrdinal}`,
        } }),
      });
      assert.equal(response.status, 200);
      let preparationSettled = false;
      for (let poll = 0; poll < 150; poll++) {
        const row = (await db.query<{ status: string; eve_session_id: string | null }>(
          "SELECT status,eve_session_id FROM telegram_ingress_updates WHERE update_id=$1", [900_000_000 + preparationOrdinal],
        )).rows[0];
        if (row?.status === "completed") {
          assert.ok(row.eve_session_id);
          const session = await t.target.attachSession(row.eve_session_id, { startIndex: cursors.get(row.eve_session_id) ?? 0 });
          session.event("session.failed");
          preparationSettled = true;
          break;
        }
        assert.notEqual(row?.status, "failed", "Preparation must terminate through the native session lifecycle");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(preparationSettled, "Mandatory preparation failure did not settle");
      assert.equal((await db.query("SELECT 1 FROM telegram_conversation_test_model_calls WHERE marker=$1",
        [`conversation-probe-${preparationOrdinal}`])).rowCount, 0);
      t.log("verified mandatory preparation failure stops before the model");
      await db.query("DROP TRIGGER telegram_test_reject_binding ON conversation_sessions");
      await db.query("DROP FUNCTION telegram_test_reject_binding()");

      let previousCancellationSession: string | undefined;
      for (const cancellationOrdinal of [turnCount + 4, turnCount + 5, turnCount + 6]) {
      const afterQuestion = cancellationOrdinal === turnCount + 6;
      let ingressUpdateId = 900_000_000 + cancellationOrdinal;
      let cancellationSessionId: string | undefined;
      await t.target.fetch("/eve/v1/telegram", {
        method: "POST", headers: { "x-telegram-bot-api-secret-token": "conversation-test-secret" },
        body: JSON.stringify({ update_id: 900_000_000 + cancellationOrdinal, message: {
          message_id: cancellationOrdinal, date: Math.floor(Date.now() / 1000),
          chat: { id: familyChatId, type: "supergroup" }, from: { id: 902, first_name: "Human", is_bot: false },
          text: `@osinara_bot conversation-probe-${cancellationOrdinal}`,
        } }),
      });
      if (afterQuestion) {
        let parkedSessionId: string | undefined;
        for (let poll = 0; poll < 150; poll++) {
          const row = (await db.query<{ status: string; eve_session_id: string }>(
            "SELECT status,eve_session_id FROM telegram_ingress_updates WHERE update_id=$1", [ingressUpdateId])).rows[0];
          if (row?.status === "completed") { parkedSessionId = row.eve_session_id; break; }
          assert.notEqual(row?.status, "failed");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(parkedSessionId, "Question did not park through the Telegram ingress");
        cancellationSessionId = parkedSessionId;
        const parked = await t.target.attachSession(parkedSessionId, { startIndex: cursors.get(parkedSessionId) ?? 0 });
        parked.event("input.requested");
        const cursor = (await db.query<{ next_event_index: number }>("SELECT next_event_index FROM eve_session_event_cursors WHERE eve_session_id=$1", [parkedSessionId])).rows[0]!;
        cursors.set(parkedSessionId, Number(cursor.next_event_index));
        const prompt = (await db.query<{ id: number; body: { reply_markup: { inline_keyboard: { callback_data: string }[][] } } }>(
          "SELECT id,body FROM telegram_conversation_test_deliveries WHERE body->'reply_markup'->'inline_keyboard'->0->0->>'callback_data' IS NOT NULL ORDER BY id DESC LIMIT 1")).rows[0];
        assert.ok(prompt, "Question button was not delivered");
        ingressUpdateId += 1;
        await t.target.fetch("/eve/v1/telegram", {
          method: "POST", headers: { "x-telegram-bot-api-secret-token": "conversation-test-secret" },
          body: JSON.stringify({ update_id: ingressUpdateId, callback_query: {
            id: "cancellation-probe-answer", chat_instance: "test-chat", data: prompt.body.reply_markup.inline_keyboard[0]![0]!.callback_data,
            from: { id: 902, first_name: "Human", is_bot: false }, message: { message_id: prompt.id,
              date: Math.floor(Date.now() / 1000), chat: { id: familyChatId, type: "supergroup" } },
          } }),
        });
      }
      let modelObserved = false;
      for (let poll = 0; poll < 100; poll++) {
        if ((await db.query("SELECT 1 FROM telegram_conversation_test_model_calls WHERE marker=$1",
          [`conversation-probe-${cancellationOrdinal}`])).rowCount === (afterQuestion ? 2 : 1)) {
          modelObserved = true;
          if (!afterQuestion) cancellationSessionId = (await db.query<{ eve_session_id: string }>(`SELECT session.eve_session_id
            FROM conversation_sessions session JOIN telegram_groups chat ON chat.id=session.group_id
            WHERE chat.telegram_chat_id=$1 AND session.kind='canonical' AND session.retired_at IS NULL`, [String(familyChatId)])).rows[0]?.eve_session_id;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(modelObserved && cancellationSessionId, "Cancellation probe did not reach the model");
      if (previousCancellationSession) assert.equal(cancellationSessionId, previousCancellationSession, "Cancellation must also work on a reused session");
      previousCancellationSession = cancellationSessionId;
      const live = t.target.watchTurn(cancellationSessionId, { startIndex: cursors.get(cancellationSessionId) ?? 0 });
      const started = await live.waitForEvent("step.started");
      const cancelRequestedAt = Date.now();
      const cancellations = await Promise.all([1, 2, 3].map(() => t.target.fetch(`/eve/v1/session/${cancellationSessionId}/cancel`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ turnId: started.data.turnId }),
      })));
      assert.ok(cancellations.every((response) => response.status === 202 || response.status === 200));
      const ending = await live.result();
      ending.event("turn.cancelled");
      ending.event("session.waiting");
      assert.ok(ending.events.some((event) => event.type === "turn.cancelled"), "Native cancellation did not stop the active turn");
      assert.ok(Date.now() - cancelRequestedAt < 5000, "Cancellation waited for the model instead of interrupting it");
      const waiting = ending.events.find((event) => event.type === "session.waiting");
      assert.equal((waiting?.data as Record<string, unknown>)?.osinaraTelegramIngressId,
        (started.data as Record<string, unknown>).osinaraTelegramIngressId, "Cancellation lost the current delivery identity");
      assert.equal((await db.query("SELECT 1 FROM telegram_conversation_test_model_calls WHERE marker=$1",
        [`conversation-probe-${cancellationOrdinal}`])).rowCount, afterQuestion ? 2 : 1, "Control replays must not execute the model twice");
      assert.equal((await db.query("SELECT 1 FROM telegram_conversation_test_deliveries WHERE body->>'text'=$1",
        [`reply-conversation-probe-${cancellationOrdinal}`])).rowCount, 0);
      let ingressCompleted = false;
      for (let poll = 0; poll < 100; poll++) {
        const row = (await db.query<{ status: string }>("SELECT status FROM telegram_ingress_updates WHERE update_id=$1", [ingressUpdateId])).rows[0];
        if (row?.status === "completed") { ingressCompleted = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(ingressCompleted, "Native cancellation did not release its ingress item");
      const cursor = (await db.query<{ next_event_index: number }>("SELECT next_event_index FROM eve_session_event_cursors WHERE eve_session_id=$1", [cancellationSessionId])).rows[0]!;
      cursors.set(cancellationSessionId, Number(cursor.next_event_index));
      }
      t.log("verified native cancellation stops a running model without a late reply");
    } finally {
      await db.query("DROP TRIGGER IF EXISTS telegram_test_reject_binding ON conversation_sessions");
      await db.query("DROP FUNCTION IF EXISTS telegram_test_reject_binding()");
      await db.query("TRUNCATE users, families CASCADE");
      await db.query("DELETE FROM telegram_ingress_updates WHERE update_id BETWEEN $1 AND $2", [
        900_000_001, 900_000_000 + turnCount + 7,
      ]);
      await db.query("DROP TABLE IF EXISTS telegram_conversation_test_deliveries, telegram_conversation_test_sandboxes, telegram_conversation_test_model_calls");
      await closeDatabase();
    }
  },
});
