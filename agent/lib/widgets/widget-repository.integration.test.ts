/**
 * Widget persistence integration tests.
 *
 * Constructs covered:
 * - A sent widget is found by its message and by its surfaceId; a surfaceId is used once per chat.
 * - Its data changes under the row lock with the next revision; a refused change leaves it as it was.
 * - A press is decided once by Telegram's query id: a redelivery finds its decision and the message
 *   stored first; a second press of the same person while the first one's message waits in the chat
 *   queue is busy, and passes once that message is completed or once a never-queued press is old;
 *   an unknown widget is closed and an action outside its list is invalid.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { telegramIngressRepository } from "../telegram-ingress-repository.js";
import { widgetRepository } from "./widget-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
const describeWithDatabase = enabled ? describe : describe.skip;

const SURFACE = {
  actions: [{ context: null, item: null, label: "Иду", name: "rsvp", quiz: false, sourceComponentId: "go", total: null, userMessage: null }],
  baked: { v0: "Идут: 1" },
  bindings: [],
  frozen: [],
  sendDataModel: false,
  slots: [],
};

async function saved(surfaceId = "trip", messageId = "7097") {
  return await widgetRepository.save({
    agentSessionId: "wrun_1", agentTurnId: "turn_1", caption: "Шашлыки", dataModel: { going: 1 },
    surface: SURFACE, surfaceId, telegramChatId: "42", telegramMessageId: messageId,
  });
}

function press(betaUpdateId: string, overrides: Partial<Parameters<typeof widgetRepository.claimQuery>[0]> = {}) {
  return widgetRepository.claimQuery({
    actionIndex: 0, betaUpdateId, ingressUpdateId: String(2n ** 50n + BigInt(betaUpdateId)), revision: 0,
    telegramChatId: "42", telegramMessageId: "7097", telegramUserId: "42", widgetQueryId: `q-${betaUpdateId}`, ...overrides,
  });
}

describeWithDatabase("widget repository", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE telegram_widget_queries, telegram_widgets, telegram_ingress_updates, telegram_ingress_queues CASCADE");
  });
  afterAll(closeDatabase);

  it("finds a sent widget by its message and its surfaceId, once per chat", async () => {
    const widget = await saved();
    expect(await widgetRepository.findByMessage("42", "7097")).toEqual(widget);
    expect(await widgetRepository.findBySurface("42", "trip")).toEqual(widget);
    expect(await widgetRepository.surfaceIdTaken("42", "trip")).toBe(true);
    expect(await widgetRepository.surfaceIdTaken("43", "trip")).toBe(false);
    await expect(saved("trip", "7098")).rejects.toThrow();
  });

  it("changes data with the next revision, and leaves it on a refused change", async () => {
    const widget = await saved();
    const updated = await widgetRepository.updateData(widget.id, async (locked) => ({ bumpRevision: true, dataModel: { going: locked.dataModel.going as number + 1 }, result: "ok" }));
    expect(updated?.widget).toMatchObject({ dataModel: { going: 2 }, revision: 1 });
    const silent = await widgetRepository.updateData(widget.id, async () => ({ bumpRevision: false, dataModel: { going: 2, note: "x" }, result: "ok" }));
    expect(silent?.widget).toMatchObject({ dataModel: { going: 2, note: "x" }, revision: 1 });
    await expect(widgetRepository.updateData(widget.id, async () => { throw new Error("telegram refused"); })).rejects.toThrow("telegram refused");
    expect(await widgetRepository.findBySurface("42", "trip")).toMatchObject({ dataModel: { going: 2, note: "x" }, revision: 1 });
  });

  it("decides a press once, and keeps one waiting press per person", async () => {
    await saved();
    const first = await press("100");
    expect(first.status).toBe("accepted");
    expect((await press("100")).status).toBe("replayed");
    // Not queued yet, then queued: either way the person's first press is still waiting.
    expect((await press("101")).status).toBe("refused_busy");
    const ingressUpdateId = String(2n ** 50n + 100n);
    await telegramIngressRepository.enqueue({ continuationKey: "42::", payload: { message: { chat: { id: 42, type: "private" }, message_id: 1, text: "x" }, update_id: 1 }, updateId: ingressUpdateId });
    expect((await press("102")).status).toBe("refused_busy");
    await database().query("UPDATE telegram_ingress_updates SET status = 'completed', completed_at = now() WHERE update_id = $1::bigint", [ingressUpdateId]);
    expect((await press("103")).status).toBe("accepted");
    expect((await press("104", { telegramUserId: "77" })).status).toBe("accepted");
  });

  it("keeps the message stored first and stops counting a press that never reached the queue", async () => {
    await saved();
    expect(await press("300")).toMatchObject({ payload: null, status: "accepted" });
    expect(await widgetRepository.storePressPayload("q-300", { message: { text: "first" } })).toEqual({ message: { text: "first" } });
    expect(await widgetRepository.storePressPayload("q-300", { message: { text: "second" } })).toEqual({ message: { text: "first" } });
    expect(await press("300")).toMatchObject({ payload: { message: { text: "first" } }, status: "replayed" });
    expect((await press("301")).status).toBe("refused_busy");
    await database().query("UPDATE telegram_widget_queries SET created_at = now() - interval '3 minutes' WHERE widget_query_id = 'q-300'");
    expect((await press("302")).status).toBe("accepted");
  });

  it("closes a press on an unknown widget and refuses an action outside its list", async () => {
    await saved();
    expect((await press("200", { telegramMessageId: "9999" })).status).toBe("refused_closed");
    expect((await press("201", { actionIndex: 5 })).status).toBe("refused_invalid");
    expect((await press("202", { actionIndex: null, revision: null })).status).toBe("refused_invalid");
  });
});
