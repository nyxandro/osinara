/**
 * Interim Telegram progress notice tests.
 *
 * Constructs covered:
 * - The durable claim precedes the send, so a replayed step never repeats a notice.
 * - A refused claim performs no Telegram call at all.
 * - A failed send is logged without failing the turn that is still producing an answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({ claim: vi.fn(), confirm: vi.fn() }));
const sendChunk = vi.hoisted(() => vi.fn());

vi.mock("./telegram-progress-notice-repository.js", () => ({
  telegramProgressNoticeRepository: repository,
}));
vi.mock("./telegram-plain-messages.js", () => ({ postTelegramPlainMessageChunk: sendChunk }));

import { deliverTelegramProgressNotice } from "./telegram-progress-notice.js";

const channel = {} as never;
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
    expect(sendChunk).toHaveBeenCalledWith(base.message, channel);
    expect(repository.confirm).toHaveBeenCalledWith("notice-1", "701");
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
