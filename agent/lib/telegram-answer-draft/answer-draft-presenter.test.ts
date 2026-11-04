/**
 * How a private chat shows a turn while it runs.
 *
 * Constructs covered:
 * - "Typing" shows at once and every four seconds while the model thinks and tools work, but not
 *   over a tool's own status, and never after the turn is answered, parked or closed.
 * - Visible text replaces it by a draft updated at most once a second and kept alive every twenty;
 *   text nobody should see (a reaction) sends nothing.
 * - Before a message goes out the presenter stops and waits for a draft still in flight, so no
 *   draft lands after the message and shows again; after a tool starts, "typing" comes back.
 * - A refusal with Telegram's wait silences every call until it has passed; a failed call is logged
 *   once and never reaches the turn.
 * - The registry keeps one presenter per turn and ignores turns it does not know.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TelegramDraftOutcome } from "../telegram-rich-messages.js";
import { createAnswerDraftPresenter, createAnswerDraftRegistry } from "./answer-draft-presenter.js";

function transport(draft = vi.fn(async (_markdown: string): Promise<TelegramDraftOutcome> => ({ ok: true }))) {
  return { draft, typing: vi.fn(async () => {}) };
}

function presenter(sent = transport(), statusBusy = () => false) {
  return { presenter: createAnswerDraftPresenter({ statusBusy, transport: sent }), sent };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("answer draft presenter", () => {
  it("shows typing at once and every four seconds while the model thinks", async () => {
    const { presenter: shown, sent } = presenter();

    await vi.advanceTimersByTimeAsync(0);
    expect(sent.typing).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sent.typing).toHaveBeenCalledTimes(3);
    shown.close();
  });

  it("replaces typing by the draft once text shows, at most once a second, with the latest text", async () => {
    const { presenter: shown, sent } = presenter();
    await vi.advanceTimersByTimeAsync(0);

    shown.text("П");
    await vi.advanceTimersByTimeAsync(0);
    shown.text("Пр");
    shown.text("При");
    await vi.advanceTimersByTimeAsync(999);
    expect(sent.draft.mock.calls).toEqual([["П"]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.draft.mock.calls).toEqual([["П"], ["При"]]);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sent.typing).toHaveBeenCalledTimes(1);
    shown.close();
  });

  it("sends no draft for a reaction and keeps typing", async () => {
    const { presenter: shown, sent } = presenter();

    shown.text("<telegram-reaction>❤️</telegram-reaction>");
    await vi.advanceTimersByTimeAsync(4_000);

    expect(sent.draft).not.toHaveBeenCalled();
    expect(sent.typing).toHaveBeenCalledTimes(2);
    shown.close();
  });

  it("keeps the draft alive every twenty seconds while the text stays the same", async () => {
    const { presenter: shown, sent } = presenter();

    shown.text("Ответ");
    await vi.advanceTimersByTimeAsync(20_000);

    expect(sent.draft.mock.calls).toEqual([["Ответ"], ["Ответ"]]);
    shown.close();
  });

  it("waits for a draft in flight before a message goes, then shows nothing until a tool starts", async () => {
    let land!: (outcome: TelegramDraftOutcome) => void;
    const sent = transport(vi.fn(() => new Promise<TelegramDraftOutcome>((resolve) => { land = resolve; })));
    const { presenter: shown } = presenter(sent);
    shown.text("Ищу рецепты");
    await vi.advanceTimersByTimeAsync(0);

    let ready = false;
    const before = shown.beforeMessage().then(() => { ready = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe(false);
    land({ ok: true });
    await before;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent.draft).toHaveBeenCalledTimes(1);
    expect(sent.typing).toHaveBeenCalledTimes(1);

    shown.toolsStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.typing).toHaveBeenCalledTimes(2);
    shown.close();
  });

  it("goes quiet for Telegram's wait after a rate limit and then shows the latest text", async () => {
    const draft = vi.fn(async (): Promise<TelegramDraftOutcome> => ({ ok: true }))
      .mockResolvedValueOnce({ description: "Too Many Requests", ok: false, providerStatus: 429, retryAfterSeconds: 5 });
    const { presenter: shown, sent } = presenter(transport(draft));

    shown.text("А");
    await vi.advanceTimersByTimeAsync(0);
    shown.text("Аб");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sent.draft).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.draft.mock.calls.at(-1)).toEqual(["Аб"]);
    expect(vi.mocked(console.warn).mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { code: "AGENT_TELEGRAM_DRAFT_UPDATE_FAILED", description: "Too Many Requests", providerStatus: 429, retryAfterSeconds: 5 },
    ]);
    shown.close();
  });

  it("logs a failed draft once and never throws to the turn", async () => {
    const { presenter: shown } = presenter(transport(vi.fn(async (): Promise<TelegramDraftOutcome> => { throw new Error("socket hang up"); })));

    expect(() => shown.text("Ответ")).not.toThrow();
    await vi.advanceTimersByTimeAsync(3_000);
    shown.text("Ответ дальше");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(vi.mocked(console.warn).mock.calls[0]![0]))).toMatchObject({ code: "AGENT_TELEGRAM_DRAFT_UPDATE_FAILED" });
    shown.close();
  });

  it("shows no typing over a tool's own status", async () => {
    let busy = false;
    const { presenter: shown, sent } = presenter(transport(), () => busy);
    await vi.advanceTimersByTimeAsync(0);

    busy = true;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sent.typing).toHaveBeenCalledTimes(1);
    busy = false;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sent.typing).toHaveBeenCalledTimes(2);
    shown.close();
  });

  it("shows nothing once the turn waits for a person or is closed", async () => {
    const { presenter: shown, sent } = presenter();
    await vi.advanceTimersByTimeAsync(0);

    shown.pause();
    shown.text("Текст");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.typing).toHaveBeenCalledTimes(1);
    expect(sent.draft).not.toHaveBeenCalled();

    shown.toolsStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.typing).toHaveBeenCalledTimes(2);
    shown.close();
    shown.toolsStarted();
    shown.text("Ещё");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.typing).toHaveBeenCalledTimes(2);
    expect(sent.draft).not.toHaveBeenCalled();
  });
});

describe("answer draft registry", () => {
  it("keeps one presenter per turn and ignores turns it does not know", async () => {
    const registry = createAnswerDraftRegistry();
    const sent = transport();
    const create = vi.fn(() => createAnswerDraftPresenter({ statusBusy: () => false, transport: sent }));

    registry.start("turn-1", create);
    registry.start("turn-1", create);
    expect(create).toHaveBeenCalledTimes(1);
    expect(registry.toolsStarted("turn-2")).toBe(false);
    expect(registry.toolsStarted("turn-1")).toBe(true);
    registry.text("turn-2", "Чужой");
    await registry.beforeMessage("turn-2");

    registry.text("turn-1", "Свой");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.draft.mock.calls).toEqual([["Свой"]]);
    await registry.close("turn-1");
    expect(registry.toolsStarted("turn-1")).toBe(false);
    await registry.close("turn-1");
  });
});
