/**
 * Reconciliation of the `/me` menu with the registered groups, against an in-memory store of set menus.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import {
  createPrivateQuestionCommandSync,
  desiredPrivateQuestionCommandScopes,
  PRIVATE_QUESTION_COMMAND,
  type PrivateQuestionCommandGroup,
} from "./private-question-commands.js";

const OWNER = "100";

function group(overrides: Partial<PrivateQuestionCommandGroup>): PrivateQuestionCommandGroup {
  return { connected: true, messageMode: "all", ownerTelegramUserId: OWNER, telegramChatId: "-1001", type: "external", ...overrides };
}

describe("desiredPrivateQuestionCommandScopes", () => {
  it("sets the menu for the whole chat in family and external groups, and only for the owner where only the owner is answered", () => {
    expect(desiredPrivateQuestionCommandScopes([
      group({ telegramChatId: "-1001" }),
      group({ telegramChatId: "-1002", type: "family_private" }),
      group({ messageMode: "owner_only", telegramChatId: "-1003" }),
      group({ connected: false, telegramChatId: "-1004" }),
    ])).toEqual([
      { scope: "chat", telegramChatId: "-1001", telegramUserId: null },
      { scope: "chat", telegramChatId: "-1002", telegramUserId: null },
      { scope: "chat_member", telegramChatId: "-1003", telegramUserId: OWNER },
    ]);
  });
});

interface Row { scope: string; telegram_chat_id: string; telegram_user_id: string | null }

function harness(groups: PrivateQuestionCommandGroup[], setRows: Row[], answers: Record<string, number> = {}) {
  const rows = [...setRows];
  const calls: { body: Record<string, unknown>; method: string }[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("FROM telegram_groups")) {
        return { rows: groups.map((item) => ({
          connected: item.connected, message_mode: item.messageMode, owner_telegram_user_id: item.ownerTelegramUserId,
          telegram_chat_id: item.telegramChatId, type: item.type,
        })) };
      }
      if (sql.startsWith("SELECT telegram_chat_id, scope")) return { rows: [...rows] };
      if (sql.includes("DELETE FROM telegram_private_question_command_scopes")) {
        const index = rows.findIndex((row) => row.telegram_chat_id === values[0] && row.scope === values[1] && row.telegram_user_id === values[2]);
        if (index >= 0) rows.splice(index, 1);
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO telegram_private_question_command_scopes")) {
        if (!rows.some((row) => row.telegram_chat_id === values[0] && row.scope === values[1] && row.telegram_user_id === values[2])) {
          rows.push({ scope: values[1] as string, telegram_chat_id: values[0] as string, telegram_user_id: values[2] as string | null });
        }
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as PoolClient;
  const sync = createPrivateQuestionCommandSync({
    withLock: (work) => work(client),
    async telegram(method, body) {
      calls.push({ body, method });
      const scope = body.scope as { chat_id: string };
      const status = answers[`${method} ${scope.chat_id}`] ?? 200;
      return { body: {}, ok: status === 200, status };
    },
  });
  return { calls, rows, sync };
}

describe("createPrivateQuestionCommandSync", () => {
  it("sets the ephemeral command per chat and remembers it", async () => {
    const { calls, rows, sync } = harness([group({ telegramChatId: "-1001" })], []);
    expect(await sync()).toEqual({ failed: [], removed: 0, set: 1 });
    expect(calls).toEqual([{
      body: { commands: [PRIVATE_QUESTION_COMMAND], scope: { chat_id: "-1001", type: "chat" } },
      method: "setMyCommands",
    }]);
    expect(PRIVATE_QUESTION_COMMAND).toEqual({ command: "me", description: "Спросить лично: ответ увидишь только ты", is_ephemeral: true });
    expect(rows).toEqual([{ scope: "chat", telegram_chat_id: "-1001", telegram_user_id: null }]);
  });

  it("takes the chat-wide menu down when the group starts answering only the owner", async () => {
    const { calls, rows, sync } = harness(
      [group({ messageMode: "owner_only", telegramChatId: "-1001" })],
      [{ scope: "chat", telegram_chat_id: "-1001", telegram_user_id: null }],
    );
    expect(await sync()).toEqual({ failed: [], removed: 1, set: 1 });
    expect(calls.map((call) => [call.method, call.body.scope])).toEqual([
      ["deleteMyCommands", { chat_id: "-1001", type: "chat" }],
      ["setMyCommands", { chat_id: "-1001", type: "chat_member", user_id: OWNER }],
    ]);
    expect(rows).toEqual([{ scope: "chat_member", telegram_chat_id: "-1001", telegram_user_id: OWNER }]);
  });

  it("takes down the menu of a group that is disconnected or no longer in the database", async () => {
    const { rows, sync } = harness(
      [group({ connected: false, telegramChatId: "-1001" })],
      [
        { scope: "chat", telegram_chat_id: "-1001", telegram_user_id: null },
        { scope: "chat", telegram_chat_id: "-1009", telegram_user_id: null },
      ],
    );
    expect(await sync()).toEqual({ failed: [], removed: 2, set: 0 });
    expect(rows).toEqual([]);
  });

  it("counts a chat the bot has left as taken down", async () => {
    const { rows, sync } = harness([], [{ scope: "chat", telegram_chat_id: "-1009", telegram_user_id: null }], {
      "deleteMyCommands -1009": 403,
    });
    expect(await sync()).toEqual({ failed: [], removed: 1, set: 0 });
    expect(rows).toEqual([]);
  });

  it("reports a failure and keeps going with the other groups", async () => {
    const { rows, sync } = harness([group({ telegramChatId: "-1001" }), group({ telegramChatId: "-1002" })], [], {
      "setMyCommands -1001": 500,
    });
    const result = await sync();
    expect(result.set).toBe(1);
    expect(result.failed).toEqual([{ code: "setMyCommands", scope: { scope: "chat", telegramChatId: "-1001", telegramUserId: null }, status: 500 }]);
    expect(rows).toEqual([{ scope: "chat", telegram_chat_id: "-1002", telegram_user_id: null }]);
  });
});
