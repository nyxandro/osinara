/**
 * The tools that send a widget and update an A2UI widget already in the chat.
 *
 * Constructs covered:
 * - An A2UI surface is validated, built, sent on the beta address with `allow_queries` when it has an
 *   action, stored, and entered into the history with its surfaceId; logs carry sizes, not content.
 * - Description errors come back at once in A2UI's format; a reused surfaceId is an integrity error;
 *   Telegram's size refusal is a fixable input error; a refusal and an unknown outcome end the tool.
 * - The model's own HTML passes the quick and the official check and goes without `allow_queries`;
 *   a refusal of either check is an input error, an unavailable check sends nothing.
 * - `update_widget` changes bound values through the shared state only after Telegram took them, finds
 *   only this chat's widget, and refuses what the HTML froze.
 */
import type { ToolContext } from "../../runtime/tool.js";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { createSendWidgetTool } from "../tools/send_widget.js";
import { createUpdateWidgetTool } from "../tools/update_widget.js";
import { WIDGET_EXAMPLES } from "../widgets/a2ui/widget-examples.js";
import { prepareWidgetButtons } from "../widgets/widget-buttons.js";
import { TELEGRAM_LINK_GUARD } from "../widgets/html/telegram-link-guard.js";
import { TELEGRAM_WIDGET_API_BASE_URL } from "../widgets/widget-config.js";
import type { StoredWidget } from "../widgets/widget-repository.js";

function context(extra: Record<string, string> = {}): ToolContext {
  return {
    callId: "call-widget-1",
    session: {
      auth: {
        current: {
          attributes: { familyId: "family-1", role: "owner", telegramChatId: "42", telegramChatType: "private", ...extra },
          authenticator: "telegram",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "wrun-widget",
      turn: { id: "turn-widget", sequence: 1 },
    },
  } as unknown as ToolContext;
}

/** The caption's buttons as `prepareWidgetButtons` returns them; a plain caption has none. */
function plainButtons(caption: string) {
  return { afterDelivery: vi.fn(), afterRefusal: vi.fn(), caption, labels: [], replyMarkup: null };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    // The real reader: a caption without button markup needs no database.
    buttons: vi.fn(prepareWidgetButtons),
    check: vi.fn(async () => ({ refusals: [], warnings: [] })),
    recordTimeline: vi.fn().mockResolvedValue(true),
    repository: { save: vi.fn(async (input: unknown) => input), surfaceIdTaken: vi.fn(async () => false) },
    send: vi.fn().mockResolvedValue({ telegramMessageId: "7097" }),
    ...overrides,
  };
}

const MENU = WIDGET_EXAMPLES.find((example) => example.name === "menu")!;
const SCHEDULE = WIDGET_EXAMPLES.find((example) => example.name === "schedule")!;
const GAME = "<style>button{width:30%}</style><div id='b'></div><script>for(let i=0;i<9;i++){const c=document.createElement('button');c.textContent='·';c.onclick=()=>{c.textContent='X'};document.getElementById('b').append(c)}</script>";

async function send(deps: ReturnType<typeof dependencies>, input: unknown, extra: Record<string, string> = {}) {
  return await createSendWidgetTool(deps as never).execute(input as never, context(extra)) as Record<string, unknown>;
}

function contract(error: unknown): Record<string, unknown> {
  return JSON.parse((error as Error).message.replace(/^[A-Z_]+: /u, "")) as Record<string, unknown>;
}

describe("send_widget buttons under the card (#480)", () => {
  it("sends the caption without markup and the buttons as the card's keyboard, then offers them", async () => {
    const keyboard = { inline_keyboard: [[{ callback_data: "rb:AbCdEfGhIjKlMnOpQrStUv:0", style: "success", text: "✅ Задачи на день услышаны" }]] };
    const buttons = { ...plainButtons("Задачи на сегодня: 4"), labels: ["✅ Задачи на день услышаны"], replyMarkup: keyboard };
    const deps = dependencies({ buttons: vi.fn(async () => buttons) });

    await send(deps, { caption: "Задачи на сегодня: 4 <tg-button type=\"read\" schedule=\"x\">✅ Задачи на день услышаны</tg-button>", surface: SCHEDULE.message });

    const call = deps.send.mock.calls[0]![0] as { body: Record<string, unknown> };
    expect(call.body).toMatchObject({ caption: "Задачи на сегодня: 4", reply_markup: keyboard });
    expect(buttons.afterDelivery).toHaveBeenCalledWith("7097");
    expect(deps.repository.save).toHaveBeenCalledWith(expect.objectContaining({ caption: "Задачи на сегодня: 4" }));
    expect(deps.recordTimeline).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      contentText: expect.stringContaining("[кнопки: «✅ Задачи на день услышаны»]"),
    }));
  });

  it("takes the buttons back when Telegram refuses the card", async () => {
    const buttons = plainButtons("Задачи");
    const refused = Object.assign(new Error("refused"), { code: "AGENT_WIDGET_DELIVERY_FAILED" });
    const deps = dependencies({ buttons: vi.fn(async () => buttons), send: vi.fn().mockRejectedValue(refused) });

    await expect(send(deps, { caption: "Задачи", surface: SCHEDULE.message })).rejects.toThrow();
    expect(buttons.afterRefusal).toHaveBeenCalledOnce();
    expect(buttons.afterDelivery).not.toHaveBeenCalled();
  });

  it("keeps the buttons ready when the send's outcome is unknown", async () => {
    const buttons = plainButtons("Задачи");
    const ambiguous = Object.assign(new Error("timeout"), { code: "AGENT_WIDGET_DELIVERY_AMBIGUOUS" });
    const deps = dependencies({ buttons: vi.fn(async () => buttons), send: vi.fn().mockRejectedValue(ambiguous) });

    await expect(send(deps, { caption: "Задачи", surface: SCHEDULE.message })).rejects.toThrow();
    expect(buttons.afterRefusal).not.toHaveBeenCalled();
  });

  it("tells a scenario run that presses go to the chat, not to it", async () => {
    const deps = dependencies();

    const result = await send(deps, { caption: MENU.caption, surface: MENU.message }, { scheduledRunId: "run-1" });

    expect(result.nextStep).toMatch(/придут не сюда, а в разговор этого чата/u);
    expect(result.nextStep).not.toMatch(/update_widget/u);
  });
});

describe("send_widget", () => {
  it("builds, sends, stores and records an A2UI widget", async () => {
    const deps = dependencies();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = await send(deps, { caption: MENU.caption, surface: MENU.message });
    expect(result).toMatchObject({ actions: ["menu_done"], delivered: true, surfaceId: "menu_2026_11_09", telegramMessageId: "7097", updatable: true });
    const call = deps.send.mock.calls[0]![0] as { apiBaseUrl: string; body: Record<string, unknown>; method: string; target: unknown };
    expect(call).toMatchObject({ apiBaseUrl: TELEGRAM_WIDGET_API_BASE_URL, method: "sendWidget", target: { chatId: "42" } });
    expect(call.body).toMatchObject({ allow_queries: true, caption: MENU.caption });
    expect(String(call.body.html)).toContain("Борщ");
    expect(deps.repository.save).toHaveBeenCalledWith(expect.objectContaining({ surfaceId: "menu_2026_11_09", telegramChatId: "42", telegramMessageId: "7097" }));
    expect(deps.recordTimeline).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ contentText: `[виджет menu_2026_11_09] ${MENU.caption}` }));
    expect(JSON.stringify(info.mock.calls)).not.toContain("Борщ");
    info.mockRestore();
  });

  it("sends a widget without actions without allow_queries", async () => {
    const deps = dependencies();
    await send(deps, { caption: SCHEDULE.caption, surface: SCHEDULE.message });
    expect((deps.send.mock.calls[0]![0] as { body: Record<string, unknown> }).body.allow_queries).toBeUndefined();
  });

  it("returns every description error at once in A2UI's format", async () => {
    const deps = dependencies();
    const broken = { createSurface: { catalogId: "basic", components: [{ component: "TextField", id: "name" }], surfaceId: "x" }, version: "1.0" };
    const error = await send(deps, { caption: "Форма", surface: broken }).catch((caught: unknown) => caught);
    const found = contract(error);
    expect(found).toMatchObject({ code: "AGENT_WIDGET_SURFACE_INVALID", retryable: true, sideEffectStatus: "not_started" });
    expect(String(found.correction)).toContain("/createSurface/catalogId");
    expect(String(found.correction)).toContain("/createSurface/components/0/component");
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("refuses a surfaceId already used in this chat", async () => {
    const deps = dependencies({ repository: { save: vi.fn(), surfaceIdTaken: vi.fn(async () => true) } });
    const error = await send(deps, { caption: MENU.caption, surface: MENU.message }).catch((caught: unknown) => caught);
    expect(String(contract(error).correction)).toContain("INTEGRITY_ERROR");
  });

  it("turns Telegram's size refusal into a fixable error and other refusals into the end of the tool", async () => {
    const tooLarge = dependencies({ send: vi.fn().mockRejectedValue(new AppError("AGENT_WIDGET_TOO_LARGE", "Telegram насчитал виджет больше")) });
    expect(contract(await send(tooLarge, { caption: MENU.caption, surface: MENU.message }).catch((caught: unknown) => caught))).toMatchObject({ code: "AGENT_WIDGET_TOO_LARGE", retryable: true });
    const refused = dependencies({ send: vi.fn().mockRejectedValue(new AppError("AGENT_WIDGET_DELIVERY_FAILED", "Telegram не принял виджет")) });
    expect(contract(await send(refused, { caption: MENU.caption, surface: MENU.message }).catch((caught: unknown) => caught))).toMatchObject({ code: "AGENT_WIDGET_DELIVERY_FAILED", retryable: false, sideEffectStatus: "not_started" });
    const unknown = dependencies({ send: vi.fn().mockRejectedValue(new AppError("AGENT_WIDGET_DELIVERY_AMBIGUOUS", "Не удалось подтвердить")) });
    expect(contract(await send(unknown, { caption: MENU.caption, surface: MENU.message }).catch((caught: unknown) => caught))).toMatchObject({ code: "AGENT_WIDGET_DELIVERY_AMBIGUOUS", sideEffectStatus: "unknown" });
  });

  it("keeps a sent widget it could not store, unpressable", async () => {
    const deps = dependencies({ repository: { save: vi.fn().mockRejectedValue(new Error("db down")), surfaceIdTaken: vi.fn(async () => false) } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await send(deps, { caption: MENU.caption, surface: MENU.message })).toMatchObject({ actions: [], delivered: true, updatable: false });
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it("checks the model's own HTML twice and sends it unconnected", async () => {
    const deps = dependencies();
    expect(await send(deps, { caption: "Крестики-нолики", height: 320, html: GAME })).toMatchObject({ delivered: true, updatable: false });
    const call = deps.send.mock.calls[0]![0] as { body: Record<string, unknown> };
    expect(call.body).toMatchObject({ height: 320, html: `${TELEGRAM_LINK_GUARD}${GAME}` });
    expect(call.body.allow_queries).toBeUndefined();
    expect(deps.check).toHaveBeenCalledWith(`${TELEGRAM_LINK_GUARD}${GAME}`);
    expect(deps.recordTimeline).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ contentText: "[виджет] Крестики-нолики" }));
  });

  it("refuses own HTML either check rejects, and sends nothing when the official check is unavailable", async () => {
    const quick = dependencies();
    expect(contract(await send(quick, { caption: "Игра", html: "<input><script>fetch('x')</script>" }).catch((caught: unknown) => caught))).toMatchObject({ code: "AGENT_WIDGET_HTML_REFUSED", retryable: true });
    expect(quick.check).not.toHaveBeenCalled();
    const official = dependencies({ check: vi.fn(async () => ({ refusals: [{ code: "script_error", hint: "ReferenceError" }], warnings: [] })) });
    expect(String(contract(await send(official, { caption: "Игра", html: GAME }).catch((caught: unknown) => caught)).correction)).toContain("ReferenceError");
    const down = dependencies({ check: vi.fn().mockRejectedValue(new AppError("AGENT_WIDGET_HTML_CHECK_UNAVAILABLE", "Проверка не ответила")) });
    expect(contract(await send(down, { caption: "Игра", html: GAME }).catch((caught: unknown) => caught))).toMatchObject({ code: "AGENT_WIDGET_HTML_CHECK_UNAVAILABLE", retryable: false });
    expect(down.send).not.toHaveBeenCalled();
  });

  it("needs a caption and exactly one of surface and html", async () => {
    const deps = dependencies();
    for (const input of [{ surface: MENU.message }, { caption: "x", html: GAME, surface: MENU.message }, { caption: "x" }, { caption: "x", height: 300, surface: MENU.message }, { caption: "x".repeat(301), html: GAME }]) {
      expect(contract(await send(deps, input).catch((caught: unknown) => caught))).toMatchObject({ code: "AGENT_WIDGET_INPUT_INVALID" });
    }
  });
});

function storedWidget(): StoredWidget {
  return {
    agentSessionId: "wrun", caption: "Шашлыки", dataModel: { going: 1 }, id: "w1", revision: 0,
    surface: {
      actions: [],
      baked: { v0: "Идут: 1" },
      bindings: [{ field: "/createSurface/components/0/text", item: null, kind: "text", max: null, node: "v0", value: { "@call": "formatString", args: { value: "Идут: ${/going}" } } }],
      frozen: [],
      sendDataModel: false,
      slots: [],
    },
    surfaceId: "trip", telegramChatId: "42", telegramMessageId: "7097",
  };
}

describe("update_widget", () => {
  const update = (value: unknown, surfaceId = "trip") => ({ updates: [{ updateDataModel: { path: "/going", surfaceId, value }, version: "1.0" }] });

  function updateDependencies(edit = vi.fn(async () => undefined)) {
    const widget = storedWidget();
    return {
      repository: {
        findBySurface: vi.fn(async (chatId: string, surfaceId: string) => chatId === "42" && surfaceId === "trip" ? widget : null),
        updateData: vi.fn(async (_id: string, change: (locked: StoredWidget) => Promise<{ dataModel: unknown; result: unknown } | null>) => {
          const changed = await change(widget);
          return changed === null ? null : { result: changed.result, widget: { ...widget, dataModel: changed.dataModel, revision: 1 } };
        }),
      },
      telegram: { editPublicData: edit },
    };
  }

  it("changes a bound text through the shared state", async () => {
    const deps = updateDependencies();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect(await createUpdateWidgetTool(deps as never).execute(update(3) as never, context())).toMatchObject({ revision: 1, updated: true, visibleChanges: 1 });
    expect(deps.telegram.editPublicData).toHaveBeenCalledWith({ chatId: "42", messageId: "7097", publicData: JSON.stringify({ p: {}, r: 1, v: { v0: "Идут: 3" } }) });
  });

  it("finds only this chat's widget and refuses a malformed update", async () => {
    const deps = updateDependencies();
    await expect(createUpdateWidgetTool(deps as never).execute(update(3, "other") as never, context())).rejects.toMatchObject({ code: "AGENT_WIDGET_NOT_FOUND" });
    await expect(createUpdateWidgetTool(deps as never).execute({ updates: [{}] } as never, context())).rejects.toMatchObject({ code: "AGENT_WIDGET_UPDATE_INVALID" });
  });

  it("keeps the data when Telegram refuses the edit", async () => {
    const deps = updateDependencies(vi.fn().mockRejectedValue(new AppError("AGENT_WIDGET_UPDATE_FAILED", "Telegram не принял")));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(createUpdateWidgetTool(deps as never).execute(update(3) as never, context())).rejects.toMatchObject({ code: "AGENT_WIDGET_UPDATE_FAILED" });
  });
});
