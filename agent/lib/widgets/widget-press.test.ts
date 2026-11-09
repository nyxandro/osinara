/**
 * A press in an A2UI widget, from Telegram's `widget_query` to the presser's queued message.
 *
 * Constructs covered:
 * - An accepted press is queued as the presser's message with A2UI's action (name, context resolved
 *   against the person's marks) before the widget is answered `{"ok":1}`.
 * - Busy, closed and invalid presses are answered with their code and never queued; a press outside a
 *   private chat is closed; a redelivered press enqueues the same message under the same number.
 * - The message answers the widget's conversation only when that conversation takes replies.
 */
import { describe, expect, it, vi } from "vitest";

import { renderWidget } from "./a2ui/render.js";
import { validateCreateSurface } from "./a2ui/validate-surface.js";
import { WIDGET_EXAMPLES } from "./a2ui/widget-examples.js";
import { createWidgetPressHandler, WIDGET_PRESS_UPDATE_ID_BASE } from "./widget-press.js";
import type { StoredWidget, WidgetQueryClaim, WidgetScenario } from "./widget-repository.js";

function menuWidget(): StoredWidget {
  const validated = validateCreateSurface(WIDGET_EXAMPLES.find((example) => example.name === "menu")!.message);
  if (!validated.ok) throw new Error("menu");
  const rendered = renderWidget(validated.surface);
  if (!rendered.ok) throw new Error("menu");
  const { actions, baked, bindings, frozen, slots } = rendered.widget;
  return {
    agentSessionId: "s1", caption: "Меню на неделю", dataModel: validated.surface.dataModel, id: "w1", revision: 0,
    surface: { actions, baked, bindings, frozen, sendDataModel: false, slots }, surfaceId: "menu_2026_11_09", telegramChatId: "42", telegramMessageId: "7097",
  };
}

function update(data: string, chatType = "private") {
  return {
    update_id: 69_454_100,
    widget_query: {
      chat: { first_name: "Аня", id: 42, type: chatType },
      chat_instance: "-1",
      data,
      from: { first_name: "Аня", id: 42, is_bot: false },
      id: "q-1",
      message_id: 7097,
      type: { type: "default" },
    },
  };
}

function dependencies(claim: (widget: StoredWidget) => WidgetQueryClaim, replyOpen = false, scenario: WidgetScenario | null = null) {
  const widget = menuWidget();
  const calls: string[] = [];
  let stored: unknown = null;
  const deps = {
    botUserId: async () => "555",
    continuationKey: ({ chatId, conversationId }: { chatId: string; conversationId?: string }) => `telegram:${chatId}${conversationId === undefined ? "" : `:${conversationId}`}`,
    enqueue: vi.fn(async () => { calls.push("enqueue"); return "enqueued"; }),
    replyRouteIsOpen: vi.fn(async () => replyOpen),
    repository: {
      claimQuery: vi.fn(async () => claim(widget)),
      findByMessage: vi.fn(async () => widget),
      scenarioOf: vi.fn(async () => scenario),
      storePressPayload: vi.fn(async (_id: string, payload: unknown) => {
        stored ??= payload;
        return stored;
      }),
    },
    telegram: { answerQuery: vi.fn(async () => { calls.push("answer"); }) },
  };
  return { calls, deps, widget };
}

const accepted = (widget: StoredWidget): WidgetQueryClaim => ({ ingressUpdateId: String(WIDGET_PRESS_UPDATE_ID_BASE + 69_454_100n), payload: null, status: "accepted", widget });

describe("widget presses", () => {
  it("queues the presser's message with the action, then answers ok", async () => {
    const { calls, deps } = dependencies(accepted);
    // Borsch and plov marked: bits 110000 → "w" in the widget's alphabet.
    await createWidgetPressHandler(deps as never)(update("a0.0.w"));
    expect(calls).toEqual(["enqueue", "answer"]);
    const queued = (deps.enqueue.mock.calls[0] as unknown as [{ continuationKey: string; payload: { message: { text: string; message_id: number }; update_id: number }; updateId: string }])[0];
    expect(queued.continuationKey).toBe("telegram:42");
    expect(queued.updateId).toBe(String(WIDGET_PRESS_UPDATE_ID_BASE + 69_454_100n));
    const [line, json] = queued.payload.message.text.split("\n");
    expect(line).toBe("[Pressed «Готово» in your widget «Меню на неделю»]");
    expect(JSON.parse(json!)).toEqual({
      action: expect.objectContaining({ context: { dishes: ["borsch", "plov"] }, name: "menu_done", sourceComponentId: "done", surfaceId: "menu_2026_11_09", userMessage: "Выбрала блюда на неделю" }),
      version: "1.0",
    });
    expect(deps.telegram.answerQuery).toHaveBeenCalledWith({ data: "{\"ok\":1}", widgetQueryId: "q-1" });
  });

  it("names the scenario and the moment of its run when a scenario sent the widget (#480)", async () => {
    const scenario = { id: "7e967fe7-9651-460d-a7d7-d94202b77757", scheduledForLocal: "09.11.2026 07:30", title: "Утренние задачи" };
    const { deps } = dependencies(accepted, false, scenario);
    await createWidgetPressHandler(deps as never)(update("a0.0.w"));
    const queued = (deps.enqueue.mock.calls[0] as unknown as [{ payload: { message: { text: string } } }])[0];
    expect(queued.payload.message.text.split("\n")[0]).toBe(
      "[Pressed «Готово» in your widget «Меню на неделю» sent by your scheduled scenario «Утренние задачи» (schedule_id 7e967fe7-9651-460d-a7d7-d94202b77757, run of 09.11.2026 07:30 local time); read it with manage_agent_schedule list to see what this press means]",
    );
    expect(deps.repository.scenarioOf).toHaveBeenCalledWith("w1");
  });

  it("answers busy, closed and invalid presses without queueing them", async () => {
    for (const status of ["refused_busy", "refused_closed", "refused_invalid"] as const) {
      const { deps } = dependencies(() => ({ status }));
      await createWidgetPressHandler(deps as never)(update("a0.0.A"));
      expect(deps.enqueue).not.toHaveBeenCalled();
      expect(deps.telegram.answerQuery).toHaveBeenCalledWith({ data: JSON.stringify({ err: status.replace("refused_", "") }), widgetQueryId: "q-1" });
    }
  });

  it("closes a press outside a private chat before touching the widget", async () => {
    const { deps } = dependencies(accepted);
    await createWidgetPressHandler(deps as never)(update("a0.0.A", "supergroup"));
    expect(deps.repository.claimQuery).not.toHaveBeenCalled();
    expect(deps.telegram.answerQuery).toHaveBeenCalledWith({ data: "{\"err\":\"closed\"}", widgetQueryId: "q-1" });
  });

  it("passes unreadable data on as an invalid press", async () => {
    const { deps } = dependencies(() => ({ status: "refused_invalid" }));
    await createWidgetPressHandler(deps as never)(update("tap:1"));
    expect(deps.repository.claimQuery).toHaveBeenCalledWith(expect.objectContaining({ actionIndex: null, revision: null }));
  });

  it("enqueues byte for byte the same message when a press is delivered again", async () => {
    let first: unknown = null;
    const { deps } = dependencies((widget) => first === null
      ? accepted(widget)
      : { ingressUpdateId: String(WIDGET_PRESS_UPDATE_ID_BASE + 69_454_100n), payload: first as never, status: "replayed", widget });
    await createWidgetPressHandler(deps as never)(update("a0.0.w"));
    first = (deps.enqueue.mock.calls[0] as unknown as [{ payload: unknown }])[0].payload;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await createWidgetPressHandler(deps as never)(update("a0.0.w"));
    const [one, two] = deps.enqueue.mock.calls.map((call) => JSON.stringify((call as unknown as [{ payload: unknown; updateId: string }])[0]));
    expect(two).toBe(one);
    expect(deps.repository.storePressPayload).toHaveBeenCalledTimes(1);
  });

  it("answers the widget's conversation when it takes replies", async () => {
    const { deps } = dependencies(accepted, true);
    await createWidgetPressHandler(deps as never)(update("a0.0.A"));
    expect(deps.replyRouteIsOpen).toHaveBeenCalledWith("telegram:42:7097");
    const queued = (deps.enqueue.mock.calls[0] as unknown as [{ payload: { message: Record<string, unknown> } }])[0];
    expect(queued.payload.message.reply_to_message).toEqual({ chat: expect.objectContaining({ id: 42 }), from: { first_name: "bot", id: 555, is_bot: true }, message_id: 7097 });
  });

  it("refuses a widget query of another shape without answering", async () => {
    const { deps } = dependencies(accepted);
    await createWidgetPressHandler(deps as never)({ update_id: 1, widget_query: { id: "q" } });
    expect(deps.telegram.answerQuery).not.toHaveBeenCalled();
  });
});
