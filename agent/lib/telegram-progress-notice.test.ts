/**
 * Interim Telegram progress notice tests.
 *
 * Constructs covered:
 * - The durable claim precedes the send, so a replayed step never repeats a notice.
 * - A refused claim performs no Telegram call at all.
 * - A failed send is logged without failing the turn that is still producing an answer.
 * - A notice is presented like a final answer: markup goes out rich, never as raw symbols.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({ claim: vi.fn(), confirm: vi.fn() }));
const sendChunk = vi.hoisted(() => vi.fn());
const sendRichChunk = vi.hoisted(() => vi.fn());

vi.mock("./telegram-progress-notice-repository.js", () => ({
  telegramProgressNoticeRepository: repository,
}));
vi.mock("./telegram-plain-messages.js", () => ({ postTelegramPlainMessageChunk: sendChunk }));
vi.mock("./telegram-rich-messages.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./telegram-rich-messages.js")>(),
  postTelegramRichMessageChunk: sendRichChunk,
}));

import { deliverTelegramProgressNotice } from "./telegram-progress-notice.js";

const telegram = { chatId: "100" };
const state = { chatType: "private" };
const channel = { state, telegram } as never;
const base = {
  applicationSessionId: "00000000-0000-4000-8000-000000000001",
  channel,
  agentSessionId: "wrun_session_1",
  agentTurnId: "turn-1",
  message: "Приступаю: сначала соберу информацию",
  stepIndex: 0,
};

describe("Telegram progress notice", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends the notice once and confirms the claim", async () => {
    repository.claim.mockResolvedValue({ noticeId: "notice-1" });
    sendChunk.mockResolvedValue({ chatType: "private", messageId: "701" });

    await deliverTelegramProgressNotice(base);

    expect(repository.claim).toHaveBeenCalledWith({
      applicationSessionId: base.applicationSessionId,
      agentSessionId: base.agentSessionId,
      agentTurnId: base.agentTurnId,
      stepIndex: 0,
    });
    expect(sendChunk).toHaveBeenCalledWith(base.message, channel, undefined);
    expect(sendRichChunk).not.toHaveBeenCalled();
    expect(repository.confirm).toHaveBeenCalledWith("notice-1", "701");
  });

  it("sends a notice with markup as a rich message instead of raw symbols", async () => {
    repository.claim.mockResolvedValue({ noticeId: "notice-3" });
    sendRichChunk.mockResolvedValue({ chatType: "private", messageId: "702" });
    const message = "### 🧂 Ингредиенты\n- 4 картофеля\n- 50 г масла";

    await deliverTelegramProgressNotice({ ...base, message });

    expect(sendChunk).not.toHaveBeenCalled();
    expect(sendRichChunk).toHaveBeenCalledTimes(1);
    const [markdown, target, richState, replyParameters] = sendRichChunk.mock.calls[0]!;
    expect(markdown).toContain("### 🧂 Ингредиенты");
    expect(markdown).toContain("- 4 картофеля");
    expect(target).toBe(telegram);
    expect(richState).toBe(state);
    expect(replyParameters).toBeUndefined();
    expect(repository.confirm).toHaveBeenCalledWith("notice-3", "702");
  });

  it("performs no Telegram call when the claim is refused", async () => {
    repository.claim.mockResolvedValue(null);

    await deliverTelegramProgressNotice(base);

    expect(sendChunk).not.toHaveBeenCalled();
    expect(repository.confirm).not.toHaveBeenCalled();
  });

  it("keeps the working turn alive when Telegram refuses the notice", async () => {
    repository.claim.mockResolvedValue({ noticeId: "notice-2" });
    sendChunk.mockRejectedValue(new Error("Telegram sendMessage failed with HTTP 403."));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(deliverTelegramProgressNotice(base)).resolves.toBeUndefined();

    expect(repository.confirm).not.toHaveBeenCalled();
    expect(logged.mock.calls[0]?.[0]).toContain("AGENT_TELEGRAM_PROGRESS_NOTICE_FAILED");
    logged.mockRestore();
  });
});
