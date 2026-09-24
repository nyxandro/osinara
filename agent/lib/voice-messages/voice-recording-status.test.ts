/**
 * "Recording a voice message" status tests.
 *
 * Constructs covered:
 * - The chat shows `record_voice` for the whole synthesis: at once, again after the confirmation
 *   delay (Eve's own typing status for the tool call may arrive just after the first one), then
 *   inside every five-second window Telegram keeps a chat action alive.
 * - The status stops with the operation and never outlives it, even with a request in flight.
 * - The status is presentation only: its failure never fails the voice note.
 * - The production status is Telegram's `record_voice` action in the same chat and topic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const telegram = vi.hoisted(() => ({ sendTelegramChatAction: vi.fn() }));
vi.mock("eve/channels/telegram", () => telegram);

import {
  VOICE_RECORDING_STATUS_CONFIRM_MS,
  VOICE_RECORDING_STATUS_REFRESH_MS,
  createVoiceRecordingStatus,
  withVoiceRecordingStatus,
} from "./voice-recording-status.js";

const TARGET = { chatId: "-1001", messageThreadId: 7 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

describe("voice recording status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the recording status on for the whole operation and stops with it", async () => {
    const sendAction = vi.fn().mockResolvedValue(undefined);
    const withStatus = createVoiceRecordingStatus(sendAction);
    const synthesis = deferred<string>();

    const running = withStatus(TARGET, () => synthesis.promise);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendAction).toHaveBeenCalledTimes(1);
    expect(sendAction).toHaveBeenCalledWith(TARGET);

    await vi.advanceTimersByTimeAsync(VOICE_RECORDING_STATUS_CONFIRM_MS);
    expect(sendAction).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(VOICE_RECORDING_STATUS_REFRESH_MS * 2);
    expect(sendAction).toHaveBeenCalledTimes(4);

    synthesis.resolve("voice");
    await expect(running).resolves.toBe("voice");
    await vi.advanceTimersByTimeAsync(VOICE_RECORDING_STATUS_REFRESH_MS * 3);
    expect(sendAction).toHaveBeenCalledTimes(4);
  });

  it("repeats the status inside Telegram's five-second window", () => {
    expect(VOICE_RECORDING_STATUS_CONFIRM_MS).toBeLessThan(VOICE_RECORDING_STATUS_REFRESH_MS);
    expect(VOICE_RECORDING_STATUS_REFRESH_MS).toBeLessThan(5_000);
  });

  it("waits for a status request in flight so it cannot land after the voice note", async () => {
    const request = deferred<void>();
    const sendAction = vi.fn().mockReturnValue(request.promise);
    const withStatus = createVoiceRecordingStatus(sendAction);
    let settled = false;

    const running = withStatus(TARGET, async () => "voice").then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    request.resolve();
    await expect(running).resolves.toBe("voice");
  });

  it("waits for every status request in flight, not only the latest", async () => {
    const first = deferred<void>();
    const sendAction = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const withStatus = createVoiceRecordingStatus(sendAction);
    const synthesis = deferred<string>();
    let settled = false;

    const running = withStatus(TARGET, () => synthesis.promise).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(VOICE_RECORDING_STATUS_CONFIRM_MS);
    expect(sendAction).toHaveBeenCalledTimes(2);
    synthesis.resolve("voice");
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    first.resolve();
    await expect(running).resolves.toBe("voice");
  });

  it("delivers the voice note when the status cannot be shown and reports it once", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sendAction = vi.fn().mockRejectedValue(new Error("Telegram unavailable"));
    const withStatus = createVoiceRecordingStatus(sendAction);
    const synthesis = deferred<string>();

    const running = withStatus(TARGET, () => synthesis.promise);
    await vi.advanceTimersByTimeAsync(VOICE_RECORDING_STATUS_CONFIRM_MS + VOICE_RECORDING_STATUS_REFRESH_MS);
    synthesis.resolve("voice");

    await expect(running).resolves.toBe("voice");
    expect(sendAction.mock.calls.length).toBeGreaterThan(1);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      code: "AGENT_VOICE_RECORDING_STATUS_FAILED",
      errorName: "Error",
    });
  });

  it("stops the status when the operation fails and passes its error on", async () => {
    const sendAction = vi.fn().mockResolvedValue(undefined);
    const withStatus = createVoiceRecordingStatus(sendAction);
    const failure = new Error("synthesis refused");

    await expect(withStatus(TARGET, async () => { throw failure; })).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(VOICE_RECORDING_STATUS_REFRESH_MS * 3);
    expect(sendAction).toHaveBeenCalledTimes(1);
  });

  describe("production status", () => {
    it("sends Telegram's record_voice action to the same chat and topic", async () => {
      telegram.sendTelegramChatAction.mockResolvedValue({ body: { ok: true }, ok: true, status: 200 });

      await withVoiceRecordingStatus(TARGET, async () => "voice");

      expect(telegram.sendTelegramChatAction).toHaveBeenCalledWith({
        action: "record_voice",
        chatId: "-1001",
        fetch: expect.any(Function),
        messageThreadId: 7,
      });
    });

    it("reports a refused status with the provider status so causes stay distinguishable", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      telegram.sendTelegramChatAction.mockResolvedValue({ body: { ok: false }, ok: false, status: 403 });

      await expect(withVoiceRecordingStatus(TARGET, async () => "voice")).resolves.toBe("voice");

      expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
        code: "AGENT_VOICE_RECORDING_STATUS_FAILED",
        errorCode: "AGENT_VOICE_RECORDING_STATUS_REJECTED",
        errorName: "AppError",
        providerStatus: 403,
      });
    });
  });
});
