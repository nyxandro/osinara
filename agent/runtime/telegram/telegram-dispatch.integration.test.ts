import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { closeDatabase, database } from "../../lib/database.js";
import type { SessionAuthContext } from "../context.js";
import { createApplicationSession } from "../history/history.integration-fixtures.js";
import { loadSessionHistory } from "../history/history-repository.js";
import { newSessionId } from "../ids.js";
import { findContinuation, loadChannelState } from "../session/continuations.js";
import { defineTool } from "../tool.js";
import { loadTurn } from "../turn/journal-repository.js";
import { runTurn } from "../turn/run-turn.js";
import { recordingObserver, reply, scriptedModel, testAgent, testRuntime, toolCalls } from "../turn/turn.integration-fixtures.js";
import type { TelegramChannelState, TelegramHitlCallbackResult, TelegramInboundResult } from "./channel-types.js";
import { renderTelegramInputRequest } from "./hitl.js";
import { parseTelegramUpdate, type TelegramCallbackQuery, type TelegramMessage } from "./inbound.js";
import { dispatchTelegramCallback, dispatchTelegramMessage, type TelegramChannelHooks } from "./telegram-dispatch.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");

const RUN = { abortSignal: new AbortController().signal };
const REPLY_TO_PROMPT = { reply_to_message: { chat: { id: 7, type: "private" }, from: { first_name: "Осинара", id: 1, is_bot: true }, message_id: 900 } };
const askQuestion = defineTool({
  description: "Спросить",
  execute: async (): Promise<string> => { throw new Error("ask_question never executes"); },
  inputSchema: z.object({ allowFreeform: z.boolean().optional(), prompt: z.string(), options: z.array(z.object({ id: z.string(), label: z.string() })).optional() }),
});
const change = defineTool({
  approval: () => "user-approval" as const, description: "Изменить", execute: async () => "changed", inputSchema: z.object({}),
});

function telegramApi() {
  const calls: Array<{ body: Record<string, unknown>; method: string }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body ?? "{}")), method: String(url).split("/").at(-1)! });
    return Response.json({ ok: true, result: { chat: { id: 7, type: "private" }, message_id: 900 } });
  });
  return { calls, transport: { api: { fetch: fetch as never }, credentials: { botToken: "test-token" } } };
}

function message(text: string, extra: Record<string, unknown> = {}): TelegramMessage {
  const update = parseTelegramUpdate({
    message: { chat: { id: 7, type: "private" }, from: { first_name: "Анна", id: 42, is_bot: false }, message_id: 100, text, ...extra },
    update_id: 1,
  });
  if (update?.kind !== "message") throw new Error("TEST_MESSAGE_INVALID");
  return update.message;
}

function press(data: string): TelegramCallbackQuery {
  const update = parseTelegramUpdate({
    callback_query: { data, from: { first_name: "Анна", id: 42, is_bot: false }, id: "cb-1", message: { chat: { id: 7, type: "private" }, message_id: 900 } },
    update_id: 2,
  });
  if (update?.kind !== "callback_query") throw new Error("TEST_CALLBACK_INVALID");
  return update.callbackQuery;
}

async function ownerAuth(): Promise<SessionAuthContext> {
  const { applicationSessionId } = await createApplicationSession(newSessionId());
  return { attributes: { applicationSessionId, role: "owner" }, authenticator: "telegram", principalId: "telegram:42", principalType: "user" };
}

function hooks(input: {
  readonly callback?: (token: string) => TelegramHitlCallbackResult | Promise<TelegramHitlCallbackResult>;
  readonly message?: (message: TelegramMessage) => TelegramInboundResult | Promise<TelegramInboundResult>;
  readonly transport: TelegramChannelHooks["transport"];
}): TelegramChannelHooks {
  return {
    botUsername: "osinara_bot",
    onHitlCallbackQuery: async (_ctx, _query, token) => await (input.callback ?? (() => null))(token),
    onMessage: async (_ctx, inbound) => await (input.message ?? (() => null))(inbound),
    transport: input.transport,
  };
}

async function runWith(turnId: string, tools: Record<string, typeof askQuestion | typeof change>, ...steps: Parameters<typeof scriptedModel>) {
  const model = scriptedModel(...steps);
  const outcome = await runTurn(testRuntime({ agent: testAgent(tools), callModel: model.callModel, observer: recordingObserver().observer }), turnId, RUN);
  return { model, outcome };
}

async function channelState(sessionId: string) {
  return (await loadChannelState<TelegramChannelState>(database(), sessionId))!;
}

(enabled ? describe : describe.skip)("Telegram dispatch", () => {
  beforeEach(async () => { await database().query("TRUNCATE users, families CASCADE"); });
  afterAll(closeDatabase);

  it("opens a session for a new address with the first message's state, and keeps it for later messages", async () => {
    const auth = await ownerAuth();
    const { transport } = telegramApi();
    const channel = hooks({ message: () => ({ auth, context: ["<app>контекст</app>"], continuationToken: "7::" }), transport });

    const first = await dispatchTelegramMessage(database(), channel, message("привет"), { attributes: { osinaraTelegramUpdateId: "1" } });
    const second = await dispatchTelegramMessage(database(), channel, message("ещё", { from: { first_name: "Борис", id: 43, is_bot: false } }));

    if (first.status !== "dispatched" || second.status !== "dispatched") throw new Error("TEST_EXPECTED_DISPATCH");
    expect(second.sessionId).toBe(first.sessionId);
    expect(await findContinuation(database(), { channelKind: "telegram", token: "7::" })).toBe(first.sessionId);
    expect(await channelState(first.sessionId)).toMatchObject({ chatId: "7", chatType: "private", triggeringUserId: "42" });
    const turn = await loadTurn(database(), first.turnId!);
    expect(turn.input).toEqual({ context: [expect.stringMatching(/^<telegram_context>\n[\s\S]*message_id: 100\n[\s\S]*bot_username: osinara_bot\n<\/telegram_context>$/u), "<app>контекст</app>"], message: "привет" });
    expect(turn.auth.current?.attributes).toMatchObject({ osinaraTelegramUpdateId: "1" });
    expect(turn.auth.initiator?.attributes).toMatchObject({ osinaraTelegramUpdateId: "1" });
    expect(turn.channel).toEqual({ continuationToken: "7::", kind: "telegram", metadata: { chatId: "7", chatType: "private", triggeringUserId: "42" } });
  });

  it("gives the model the application's text instead of the raw one, and lets bots reach the application hook", async () => {
    const auth = await ownerAuth();
    const seen: TelegramMessage[] = [];
    const channel = hooks({ message: (inbound) => { seen.push(inbound); return { auth, continuationToken: "7::", message: "склеенная пачка" }; }, transport: telegramApi().transport });

    const result = await dispatchTelegramMessage(database(), channel, message("сырой", { from: { first_name: "Бот", id: 99, is_bot: true } }));

    if (result.status !== "dispatched") throw new Error("TEST_EXPECTED_DISPATCH");
    expect(seen[0]?.from?.isBot).toBe(true);
    expect((await loadTurn(database(), result.turnId!)).input.message).toBe("склеенная пачка");
  });

  it("refuses a dispatch the application did not authenticate, and creates nothing for a dropped update", async () => {
    const { transport } = telegramApi();

    await expect(dispatchTelegramMessage(database(), hooks({ message: () => ({ auth: null }), transport }), message("привет")))
      .rejects.toMatchObject({ code: "AGENT_TELEGRAM_DISPATCH_AUTH_MISSING" });
    expect(await dispatchTelegramMessage(database(), hooks({ transport }), message("привет"))).toEqual({ status: "dropped" });
    expect((await database().query("SELECT 1 FROM agent_continuations")).rowCount).toBe(0);
  });

  it("creates no turn when its binding fails or the dispatch was stopped", async () => {
    const auth = await ownerAuth();
    const channel = hooks({ message: () => ({ auth, continuationToken: "7::" }), transport: telegramApi().transport });
    const stopped = new AbortController();
    stopped.abort(new Error("deadline"));

    await expect(dispatchTelegramMessage(database(), channel, message("привет"), { bind: async () => { throw new Error("binding lost"); } }))
      .rejects.toThrow("binding lost");
    await expect(dispatchTelegramMessage(database(), channel, message("привет"), { signal: stopped.signal })).rejects.toThrow("deadline");
    expect((await database().query("SELECT 1 FROM agent_turns")).rowCount).toBe(0);
    expect((await database().query("SELECT 1 FROM agent_continuations")).rowCount).toBe(0);
  });

  it("takes a text that names an option as the answer to the waiting question", async () => {
    const auth = await ownerAuth();
    const channel = hooks({ message: () => ({ auth, continuationToken: "7::" }), transport: telegramApi().transport });
    const asked = await dispatchTelegramMessage(database(), channel, message("спроси"));
    if (asked.status !== "dispatched") throw new Error("TEST_EXPECTED_DISPATCH");
    await runWith(asked.turnId!, { ask_question: askQuestion },
      toolCalls([{ id: "call-q", input: { options: [{ id: "tea", label: "Чай" }, { id: "coffee", label: "Кофе" }], prompt: "Что?" }, name: "ask_question" }]));

    const answered = await dispatchTelegramMessage(database(), channel, message("кофе"));

    if (answered.status !== "dispatched") throw new Error("TEST_EXPECTED_DISPATCH");
    const continuation = await loadTurn(database(), answered.turnId!);
    expect(continuation).toMatchObject({ input: { context: [expect.stringContaining("<telegram_context>")] }, resumesTurnId: asked.turnId });
    expect(continuation.input.message).toBeUndefined();
    const { outcome } = await runWith(continuation.id, { ask_question: askQuestion }, reply("Кофе так кофе"));
    expect(outcome).toEqual({ status: "completed", text: "Кофе так кофе" });
    expect((await loadSessionHistory(database(), asked.sessionId)).messages).toContainEqual({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call-q", toolName: "ask_question", output: { type: "json", value: { optionId: "coffee", status: "answered" } } }],
    });
  });

  it("takes a reply to the bot's freeform prompt as its answer, through the prompt's message", async () => {
    const auth = await ownerAuth();
    const channel = hooks({ message: () => ({ auth, continuationToken: "7::" }), transport: telegramApi().transport });
    const asked = await dispatchTelegramMessage(database(), channel, message("спроси"));
    if (asked.status !== "dispatched") throw new Error("TEST_EXPECTED_DISPATCH");
    await runWith(asked.turnId!, { ask_question: askQuestion }, toolCalls([{ id: "call-q", input: { prompt: "Как назвать?" }, name: "ask_question" }]));
    await database().query(
      `UPDATE agent_session_state SET channel_state = jsonb_set(channel_state::jsonb, '{pendingFreeformReplies}', '{"900":"call-q"}')::json
        WHERE session_id = $1`,
      [asked.sessionId],
    );

    const answer = await dispatchTelegramMessage(database(), channel, message("Барсик", REPLY_TO_PROMPT));

    if (answer.status !== "dispatched") throw new Error("TEST_EXPECTED_DISPATCH");
    expect((await loadTurn(database(), answer.turnId!)).resumesTurnId).toBe(asked.turnId);
    expect((await channelState(asked.sessionId)).pendingFreeformReplies).toEqual({});
  });

  it("starts an ordinary turn for a reply the application marked a message when it names no option", async () => {
    const auth = await ownerAuth();
    const channel = hooks({ message: () => ({ auth, continuationToken: "7::", replyHandling: "message" }), transport: telegramApi().transport });
    const asked = await dispatchTelegramMessage(database(), channel, message("спроси"));
    if (asked.status !== "dispatched") throw new Error("TEST_EXPECTED_DISPATCH");
    await runWith(asked.turnId!, { ask_question: askQuestion },
      toolCalls([{ id: "call-q", input: { options: [{ id: "tea", label: "Чай" }], prompt: "Что?" }, name: "ask_question" }]));

    const ordinary = await dispatchTelegramMessage(database(), channel, message("Мурка", REPLY_TO_PROMPT));

    if (ordinary.status !== "dispatched") throw new Error("TEST_EXPECTED_DISPATCH");
    // The new message dismisses the question it did not answer.
    expect(await loadTurn(database(), ordinary.turnId!)).toMatchObject({ input: { message: "Мурка" }, resumesTurnId: asked.turnId });
  });

  it("acknowledges a button the application authorized and continues the turn once; a second press does nothing", async () => {
    const auth = await ownerAuth();
    const api = telegramApi();
    const channel = hooks({
      callback: (token) => ({ acknowledgementText: "Принято", auth, continuationToken: token === "7::" ? "7::" : "unexpected" }),
      message: () => ({ auth, continuationToken: "7::" }),
      transport: api.transport,
    });
    const asked = await dispatchTelegramMessage(database(), channel, message("измени"));
    if (asked.status !== "dispatched") throw new Error("TEST_EXPECTED_DISPATCH");
    const parked = await runWith(asked.turnId!, { change }, toolCalls([{ id: "call-c", input: {}, name: "change" }]));
    if (parked.outcome.status !== "waiting_input") throw new Error("TEST_EXPECTED_PARK");
    const state = await channelState(asked.sessionId);
    const rendered = renderTelegramInputRequest(parked.outcome.requests[0]!, state);
    await database().query("UPDATE agent_session_state SET channel_state = $2::json WHERE session_id = $1", [asked.sessionId, JSON.stringify(state)]);
    const approve = (rendered.replyMarkup!.inline_keyboard as Array<Array<{ callback_data: string }>>)[0]![0]!.callback_data;

    const pressed = await dispatchTelegramCallback(database(), channel, press(approve), { attributes: { osinaraTelegramUpdateId: "2" } });
    const again = await dispatchTelegramCallback(database(), channel, press(approve));

    if (pressed.status !== "dispatched") throw new Error("TEST_EXPECTED_DISPATCH");
    expect(again).toEqual({ status: "dropped" });
    expect(api.calls.filter((call) => call.method === "answerCallbackQuery").map((call) => call.body.text)).toEqual(["Принято", "Принято"]);
    const continuation = await loadTurn(database(), pressed.turnId!);
    expect(continuation).toMatchObject({ input: { context: [] }, resumesTurnId: asked.turnId });
    expect(continuation.auth.current?.attributes).toMatchObject({ osinaraTelegramUpdateId: "2" });
  });

  it("neither acknowledges nor continues a press the application rejected", async () => {
    const auth = await ownerAuth();
    const api = telegramApi();
    const channel = hooks({ callback: () => null, message: () => ({ auth, continuationToken: "7::" }), transport: api.transport });
    await dispatchTelegramMessage(database(), channel, message("привет"));

    expect(await dispatchTelegramCallback(database(), channel, press("eve:0"))).toEqual({ status: "dropped" });
    expect(api.calls.filter((call) => call.method === "answerCallbackQuery")).toEqual([]);
  });

  it("turns an answer to a request that no longer waits into new input that authorizes nothing", async () => {
    const auth = await ownerAuth();
    const channel = hooks({ callback: () => ({ auth, continuationToken: "7::" }), message: () => ({ auth, continuationToken: "7::" }), transport: telegramApi().transport });
    const asked = await dispatchTelegramMessage(database(), channel, message("измени"));
    if (asked.status !== "dispatched") throw new Error("TEST_EXPECTED_DISPATCH");
    const parked = await runWith(asked.turnId!, { change }, toolCalls([{ id: "call-c", input: {}, name: "change" }]));
    if (parked.outcome.status !== "waiting_input") throw new Error("TEST_EXPECTED_PARK");
    const state = await channelState(asked.sessionId);
    const buttons = renderTelegramInputRequest(parked.outcome.requests[0]!, state).replyMarkup!.inline_keyboard as Array<Array<{ callback_data: string }>>;
    await database().query("UPDATE agent_session_state SET channel_state = $2::json WHERE session_id = $1", [asked.sessionId, JSON.stringify(state)]);
    const cancelled = await dispatchTelegramCallback(database(), channel, press(buttons[0]![1]!.callback_data));
    if (cancelled.status !== "dispatched") throw new Error("TEST_EXPECTED_DISPATCH");
    await runWith(cancelled.turnId!, { change }, reply("Отменил"));

    const late = await dispatchTelegramCallback(database(), channel, press(buttons[0]![0]!.callback_data));

    if (late.status !== "dispatched") throw new Error("TEST_EXPECTED_DISPATCH");
    const turn = await loadTurn(database(), late.turnId!);
    expect(turn.resumesTurnId).toBeNull();
    expect(turn.input.message).toBe([
      "The user submitted the following response to an earlier interactive prompt.",
      "Treat it as new input at the current point in the conversation and decide whether it is still relevant. This does not authorize an earlier action; request approval again if that action is still needed.",
      JSON.stringify([{
        requestId: parked.outcome.requests[0]!.requestId,
        response: { optionId: "approve", selectedOption: { id: "approve", label: "Approve" } },
        prompt: "Approve tool call: change",
        requestType: "approval",
      }], null, 2),
    ].join("\n"));
  });

  it("addresses an answer to the exact session the application verified, and refuses one that does not exist", async () => {
    const auth = await ownerAuth();
    const channel = hooks({ message: () => ({ auth, continuationToken: "7::" }), transport: telegramApi().transport });
    const first = await dispatchTelegramMessage(database(), channel, message("привет"));
    if (first.status !== "dispatched") throw new Error("TEST_EXPECTED_DISPATCH");
    await runWith(first.turnId!, {}, reply("привет!"));
    const routed = hooks({
      message: () => ({ auth: { ...auth, attributes: { ...auth.attributes, osinaraTelegramResponseSessionId: first.sessionId } }, continuationToken: "other::" }),
      transport: telegramApi().transport,
    });
    const missing = hooks({
      message: () => ({ auth: { ...auth, attributes: { ...auth.attributes, osinaraTelegramResponseSessionId: "wrun_01J00000000000000000000000" } }, continuationToken: "7::" }),
      transport: telegramApi().transport,
    });

    const answered = await dispatchTelegramMessage(database(), routed, message("ответ"));

    if (answered.status !== "dispatched") throw new Error("TEST_EXPECTED_DISPATCH");
    expect(answered.sessionId).toBe(first.sessionId);
    await expect(dispatchTelegramMessage(database(), missing, message("ответ"))).rejects.toMatchObject({ code: "AGENT_TELEGRAM_RESPONSE_SESSION_INACTIVE" });
  });
});
