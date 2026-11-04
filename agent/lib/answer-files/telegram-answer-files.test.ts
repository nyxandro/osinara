/**
 * Which turns check the files of their answer.
 *
 * Constructs covered:
 * - A delegated child answers its parent, and a turn of another channel answers no chat: their file
 *   paths are text, never checked or resolved.
 */
import { describe, expect, it, vi } from "vitest";

const resolve = vi.hoisted(() => vi.fn());
vi.mock("./answer-file-resolution.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./answer-file-resolution.js")>(),
  answerFileResolver: { resolve },
}));

import { checkTelegramAnswerFiles } from "./telegram-answer-files.js";

const text = "![](/workspace/personal/gone.jpg)";
const session = { auth: { current: undefined }, id: "session-1", turn: { id: "turn-1", sequence: 1 } };

describe("answer file check scope", () => {
  it("does not check the answer of a delegated child", async () => {
    const parent = { callId: "call-1", sessionId: "parent-session", turnId: "parent-turn" };

    expect(await checkTelegramAnswerFiles({ channel: { kind: "telegram" }, session: { ...session, parent } as never, text })).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("sends an answer with a wrong Telegram tag back to the model, before any file is looked at", async () => {
    const notice = await checkTelegramAnswerFiles({
      channel: { kind: "telegram" },
      session: session as never,
      text: "Созвон <tg-time at=\"2026-11-07T19:00\" format=\"wt\">суббота</tg-time>.",
    });

    expect(notice).toContain("some Telegram tags in it are wrong");
    expect(notice).toContain("with its offset");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not check the answer of a turn that answers no Telegram chat", async () => {
    expect(await checkTelegramAnswerFiles({ channel: { kind: "subagent" }, session: session as never, text })).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });
});
