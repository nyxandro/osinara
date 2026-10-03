/** The durable ingress, the runtime's Telegram channel and its journal together, over the test database. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { SessionAuthContext } from "../runtime/context.js";
import { createApplicationSession } from "../runtime/history/history.integration-fixtures.js";
import { loadSessionHistory } from "../runtime/history/history-repository.js";
import { newSessionId } from "../runtime/ids.js";
import { respondInSession } from "../runtime/respond.js";
import { loadChannelState, saveChannelState } from "../runtime/session/continuations.js";
import type { TelegramChannelState } from "../runtime/telegram/channel-types.js";
import { renderTelegramInputRequest } from "../runtime/telegram/hitl.js";
import { defineTool } from "../runtime/tool.js";
import { reply, toolCalls } from "../runtime/turn/turn.integration-fixtures.js";
import { closeDatabase, database } from "./database.js";
import { createTelegramDurableIngress } from "./telegram-durable-ingress.js";
import { telegramIngressRepository } from "./telegram-ingress-repository.js";
import { NO_BURSTS } from "./telegram-ingress.test-fixtures.js";
import { createApprovalTimeoutResolver, type TimedOutApprovalClaim } from "./telegram-hitl/approval-timeout.js";
import { runtimeTelegram } from "./telegram-runtime.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");

const message = (id: number, text: string) => ({ update_id: id, message: {
  chat: { id: 7, type: "private" }, date: 1_700_000_000, from: { first_name: "Анна", id: 42, is_bot: false }, message_id: id, text,
} });
const press = (id: number, data: string) => ({ update_id: id, callback_query: {
  chat_instance: "chat", data, from: { first_name: "Анна", id: 42, is_bot: false }, id: `callback-${id}`,
  message: { chat: { id: 7, type: "private" }, date: 1_700_000_000, message_id: 900 },
} });

async function ownerAuth(): Promise<SessionAuthContext> {
  const { applicationSessionId } = await createApplicationSession(newSessionId());
  return { attributes: { applicationSessionId, role: "owner", telegramUserId: "42" }, authenticator: "telegram", principalId: "telegram:42", principalType: "user" };
}

function ingressOver(telegram: ReturnType<typeof runtimeTelegram>, runTurn = telegram.runTurn) {
  return createTelegramDurableIngress({
    acceptMedia: vi.fn(), authorizeVoice: vi.fn(), botUsername: "osinara_bot", dispatch: telegram.dispatch,
    handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false), leaseMilliseconds: 60_000, privateBurst: NO_BURSTS,
    reportFailure: vi.fn(), repository: telegramIngressRepository, runTurn, transcribeVoice: vi.fn(),
  });
}

async function deliver(ingress: ReturnType<typeof createTelegramDurableIngress>, raw: Record<string, unknown>) {
  await telegramIngressRepository.enqueue({ continuationKey: "7::", payload: raw, updateId: String(raw.update_id) });
  const work: Promise<unknown>[] = [];
  await ingress.drain({ waitUntil: (task) => { work.push(task); } });
  await Promise.all(work);
}

/** The buttons the application would have rendered for the waiting request, stored in the chat state. */
async function renderButtons(sessionId: string, request: Parameters<typeof renderTelegramInputRequest>[0]) {
  const state = (await loadChannelState<TelegramChannelState>(database(), sessionId))!;
  const rendered = renderTelegramInputRequest(request, state);
  await saveChannelState(database(), sessionId, state);
  return (rendered.replyMarkup!.inline_keyboard as Array<Array<{ callback_data: string }>>)[0]!.map((button) => button.callback_data);
}

async function updates() {
  return (await database().query<{ dispatch_turn_id: string | null; eve_session_id: string | null; status: string }>(
    "SELECT status, eve_session_id, dispatch_turn_id FROM telegram_ingress_updates ORDER BY update_id",
  )).rows;
}

(enabled ? describe : describe.skip)("Telegram ingress over the runtime", () => {
  beforeEach(async () => { await database().query("TRUNCATE users, families, telegram_ingress_queues CASCADE"); });
  afterAll(closeDatabase);

  it("parks on an approval, runs the approved tool once on the button, and answers", async () => {
    const auth = await ownerAuth();
    const execute = vi.fn(async () => "изменено");
    const change = defineTool({ approval: () => "user-approval" as const, description: "Изменить", execute, inputSchema: z.object({}) });
    const telegram = runtimeTelegram({
      onHitlCallbackQuery: async () => ({ acknowledgementText: "Решение сохранено", auth, continuationToken: "7::" }),
      onMessage: async () => ({ auth, continuationToken: "7::" }),
      steps: [toolCalls([{ id: "call-c", input: {}, name: "change" }]), reply("Готово")],
      tools: { change },
    });
    const ingress = ingressOver(telegram);

    await deliver(ingress, message(100, "измени"));
    const requested = telegram.events.find((event) => event.kind === "input.requested")!;
    const [{ sessionId }] = (await database().query<{ sessionId: string }>("SELECT session_id AS \"sessionId\" FROM agent_continuations")).rows;
    const [approve] = await renderButtons(sessionId!, (requested.data as { requests: Parameters<typeof renderTelegramInputRequest>[0][] }).requests[0]!);
    expect(execute).not.toHaveBeenCalled();

    await deliver(ingress, press(101, approve!));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(telegram.events.filter((event) => event.kind === "message.completed").map((event) => (event.data as { message: string }).message))
      .toEqual(["Готово"]);
    const rows = await updates();
    expect(rows).toMatchObject([
      { eve_session_id: sessionId, status: "completed" },
      { eve_session_id: sessionId, status: "completed" },
    ]);
    expect(rows[1]!.dispatch_turn_id).not.toBe(rows[0]!.dispatch_turn_id);
    expect(telegram.fetch.mock.calls.map((call) => String((call as unknown[])[0]).split("/").at(-1))).toContain("answerCallbackQuery");
  });

  it("finishes a turn its update already created after a restart, without a second model call", async () => {
    const auth = await ownerAuth();
    const telegram = runtimeTelegram({ onMessage: async () => ({ auth, continuationToken: "7::" }), steps: [reply("Один раз")] });
    // The first process created the turn and died before running it.
    await telegramIngressRepository.enqueue({ continuationKey: "7::", payload: message(100, "привет"), updateId: "100" });
    const dying = ingressOver(telegram, () => new Promise(() => {}));
    void dying.drain({ waitUntil: () => {} });
    await vi.waitFor(async () => expect((await updates())[0]?.dispatch_turn_id).toEqual(expect.stringMatching(/^turn_/u)));
    await database().query("UPDATE telegram_ingress_updates SET lease_expires_at = now() - interval '1 second'");
    const work: Promise<unknown>[] = [];

    await ingressOver(telegram).drain({ waitUntil: (task) => { work.push(task); } });
    await Promise.all(work);

    expect(telegram.model.requests).toHaveLength(1);
    expect(await updates()).toMatchObject([{ status: "completed" }]);
    expect(telegram.events.filter((event) => event.kind === "turn.completed")).toHaveLength(1);
  });

  it("cancels an approval nobody answered and tells the model why, before the restored transcript", async () => {
    const auth = await ownerAuth();
    const execute = vi.fn(async () => "изменено");
    const change = defineTool({ approval: () => "user-approval" as const, description: "Изменить", execute, inputSchema: z.object({}) });
    const telegram = runtimeTelegram({
      onMessage: async () => ({ auth, continuationToken: "7::" }),
      steps: [toolCalls([{ id: "call-c", input: {}, name: "change" }]), reply("Не подтвердили — не сделал")],
      tools: { change },
    });
    await deliver(ingressOver(telegram), message(100, "измени"));
    const requested = telegram.events.find((event) => event.kind === "input.requested")!;
    const request = (requested.data as { requests: Array<{ requestId: string }> }).requests[0]!;
    const [{ sessionId }] = (await database().query<{ sessionId: string }>("SELECT session_id AS \"sessionId\" FROM agent_continuations")).rows;
    const claim = {
      applicationSessionId: auth.attributes.applicationSessionId as string, auth, agentSessionId: sessionId!, id: "approval-1",
      kind: "tool-approval", leaseToken: "lease-1", promptText: "Подтвердите", requestId: request.requestId,
      telegramChatId: "7", telegramMessageId: "900", toolName: "change",
    } satisfies TimedOutApprovalClaim;
    const resolve = createApprovalTimeoutResolver({
      finalizePrompt: vi.fn(async () => {}),
      repository: { claimExpired: vi.fn(async () => [claim]), completeTimeout: vi.fn(async () => true), failTimeout: vi.fn() },
      respond: (input) => respondInSession({ database: database(), dispatcher: telegram.dispatcher }, input),
    });

    expect(await resolve(new Date())).toBe(1);
    await telegram.dispatcher.idle();

    expect(execute).not.toHaveBeenCalled();
    const history = (await loadSessionHistory(database(), sessionId!)).messages;
    const notice = history.findIndex((entry) => entry.role === "user" && String(entry.content).includes("не подтвердил действие «change»"));
    const denied = history.findIndex((entry) => entry.role === "tool");
    expect(notice).toBeGreaterThan(0);
    expect(denied).toBeGreaterThan(notice);
    expect(history.at(-1)).toEqual({ role: "assistant", content: [{ type: "text", text: "Не подтвердили — не сделал" }] });
  });
});
