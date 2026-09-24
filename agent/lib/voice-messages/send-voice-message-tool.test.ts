/**
 * Model-facing ElevenLabs voice message tool tests.
 *
 * Constructs covered:
 * - One synthesis is persisted in the current scope and delivered as a Telegram voice note.
 * - Completed and filesystem-recoverable calls never spend ElevenLabs credits twice.
 * - Provider refusals such as exhausted credits become terminal ledger states and tell the model
 *   to answer the same request in text instead of retrying the voice note.
 * - An unconfirmed Telegram delivery is reported as possibly delivered, never as a clean failure.
 * - The chat shows "recording a voice message" while the voice is synthesized, not while it is sent.
 */
import { createHash } from "node:crypto";

import type { ToolContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { ModelFacingError } from "../model-facing-error.js";
import { createSendVoiceMessageTool } from "../tools/send_voice_message.js";
import { VoiceMessageProviderError } from "./elevenlabs-speech-client.js";

const CALL_ID = "call-voice-1";
const VOICE_PATH = `generated-voice/voice-${createHash("sha256")
  .update(CALL_ID, "utf8")
  .digest("hex")
  .slice(0, 24)}.ogg`;
const FILE = {
  byteSize: 11,
  contentSha256: "a".repeat(64),
  mediaType: "audio/ogg; codecs=opus",
  path: VOICE_PATH,
  scope: "personal" as const,
  updatedAt: "2026-09-23T00:00:00.000Z",
};
const INPUT = { text: "Привет! [laughs] Завтра будет солнечно." };

function context(attributes: Record<string, string> = {}): ToolContext {
  return {
    callId: CALL_ID,
    session: {
      auth: {
        current: {
          attributes: {
            familyId: "family-1",
            role: "owner",
            telegramChatId: "101",
            telegramChatType: "private",
            ...attributes,
          },
          authenticator: "telegram",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "wrun-voice",
      turn: { id: "turn-voice", sequence: 1 },
    },
  } as unknown as ToolContext;
}

function dependencies() {
  return {
    deliver: vi.fn().mockResolvedValue({
      delivered: true,
      path: FILE.path,
      persistenceCompleted: true,
      projectionCompleted: true,
      replayed: false,
      retryable: false,
      scope: "personal",
      sideEffectStatus: "completed",
      telegramMessageId: "91",
    }),
    recordingStatus: vi.fn(async (_target: unknown, operation: () => Promise<unknown>) => await operation()),
    operations: {
      begin: vi.fn().mockResolvedValue({ state: "execute", workspaceId: "workspace-1" }),
      complete: vi.fn().mockResolvedValue(undefined),
      markAmbiguous: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
    },
    speech: {
      assertConfigured: vi.fn(),
      synthesize: vi.fn().mockResolvedValue({
        bytes: Buffer.from("voice bytes"),
        characterCost: 38,
        mediaType: "audio/ogg; codecs=opus",
      }),
    },
    workspaces: {
      findBinaryWrite: vi.fn().mockResolvedValue(null),
      workspaceId: vi.fn().mockResolvedValue("workspace-1"),
      writeBinary: vi.fn().mockImplementation(async (
        _auth: unknown,
        input: { path: string; scope: "family" | "group" | "personal" },
      ) => ({ ...FILE, path: input.path, scope: input.scope })),
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<ModelFacingError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ModelFacingError);
  return error as ModelFacingError;
}

describe("send_voice_message", () => {
  it("synthesizes, stores, and delivers one voice note", async () => {
    const deps = dependencies();
    const tool = createSendVoiceMessageTool(deps as never);

    await expect(tool.execute({ ...INPUT, caption: "https://example.com" }, context())).resolves
      .toMatchObject({
        characterCost: 38,
        delivered: true,
        generated: true,
        path: VOICE_PATH,
        telegramMessageId: "91",
      });
    expect(deps.speech.synthesize).toHaveBeenCalledOnce();
    expect(deps.speech.synthesize).toHaveBeenCalledWith(INPUT.text);
    expect(deps.workspaces.writeBinary).toHaveBeenCalledWith(expect.anything(), {
      bytes: Buffer.from("voice bytes"),
      mediaType: "audio/ogg; codecs=opus",
      operationKey: CALL_ID,
      path: VOICE_PATH,
      scope: "personal",
    });
    expect(deps.operations.complete).toHaveBeenCalledWith(
      CALL_ID,
      expect.objectContaining({ path: VOICE_PATH }),
      38,
    );
    expect(deps.deliver).toHaveBeenCalledWith({
      caption: "https://example.com",
      path: VOICE_PATH,
      scope: "personal",
      text: INPUT.text,
    }, expect.anything());
  });

  it("shows the recording status in the current chat only while the voice is synthesized", async () => {
    const deps = dependencies();
    const events: string[] = [];
    deps.recordingStatus.mockImplementation(async (_target, operation) => {
      events.push("status on");
      try {
        return await operation();
      } finally {
        events.push("status off");
      }
    });
    deps.speech.synthesize.mockImplementation(async () => {
      events.push("synthesize");
      return { bytes: Buffer.from("voice bytes"), characterCost: 38, mediaType: "audio/ogg; codecs=opus" };
    });
    deps.deliver.mockImplementation(async () => {
      events.push("deliver");
      return { delivered: true, telegramMessageId: "91" };
    });
    const tool = createSendVoiceMessageTool(deps as never);

    await tool.execute(INPUT, context());

    // Telegram clears a chat action when the bot's message arrives; one sent after the voice note
    // would show "recording" under a voice that is already there.
    expect(events).toEqual(["status on", "synthesize", "status off", "deliver"]);
    expect(deps.recordingStatus).toHaveBeenCalledWith({ chatId: "101" }, expect.any(Function));
  });

  it("shows the recording status in the forum topic the voice goes to", async () => {
    const deps = dependencies();
    const tool = createSendVoiceMessageTool(deps as never);

    await tool.execute(INPUT, context({ telegramMessageThreadId: "7" }));

    expect(deps.recordingStatus).toHaveBeenCalledWith(
      { chatId: "101", messageThreadId: 7 },
      expect.any(Function),
    );
  });

  it("refuses a chat it cannot deliver to before reserving or paying for synthesis", async () => {
    const deps = dependencies();
    const tool = createSendVoiceMessageTool(deps as never);

    await failure(tool.execute(INPUT, context({ telegramMessageThreadId: "not-a-topic" })));

    expect(deps.operations.begin).not.toHaveBeenCalled();
    expect(deps.speech.synthesize).not.toHaveBeenCalled();
  });

  it("rejects a model-supplied scope and an over-long text before any reservation", async () => {
    const deps = dependencies();
    const tool = createSendVoiceMessageTool(deps as never);

    for (const input of [{ ...INPUT, scope: "family" }, { text: "а".repeat(5_001) }, { text: " " }]) {
      const error = await failure(tool.execute(input, context()));
      expect(error.contract).toMatchObject({
        category: "input",
        code: "AGENT_VOICE_MESSAGE_INPUT_INVALID",
        retryable: true,
        sideEffectStatus: "not_started",
      });
    }
    expect(deps.operations.begin).not.toHaveBeenCalled();
    expect(deps.speech.synthesize).not.toHaveBeenCalled();
  });

  it("rejects a caption that exceeds the Telegram limit after rendering before spending credits", async () => {
    const deps = dependencies();
    const tool = createSendVoiceMessageTool(deps as never);

    // 300 raw characters render to 1,500: Telegram measures the caption after entity parsing.
    const error = await failure(tool.execute({ ...INPUT, caption: "&".repeat(300) }, context()));

    expect(error.contract).toMatchObject({
      code: "AGENT_VOICE_MESSAGE_INPUT_INVALID",
      retryable: true,
      sideEffectStatus: "not_started",
    });
    expect(deps.operations.begin).not.toHaveBeenCalled();
    expect(deps.speech.synthesize).not.toHaveBeenCalled();
  });

  it("answers in text when the ElevenLabs key is not configured", async () => {
    const deps = dependencies();
    deps.speech.assertConfigured.mockImplementation(() => {
      throw new VoiceMessageProviderError(
        "AGENT_VOICE_MESSAGE_CONFIG_MISSING",
        "Голосовые сообщения не настроены: владелец ещё не задал ключ ElevenLabs",
        "definitive",
      );
    });
    const tool = createSendVoiceMessageTool(deps as never);

    const error = await failure(tool.execute(INPUT, context()));

    expect(error.contract).toMatchObject({
      code: "AGENT_VOICE_MESSAGE_CONFIG_MISSING",
      retryable: false,
      sideEffectStatus: "not_started",
    });
    expect(error.contract.correction).toMatch(/обычным текстом/u);
    expect(deps.operations.begin).not.toHaveBeenCalled();
  });

  it("records exhausted credits as a definitive failure and redirects the reply to text", async () => {
    const deps = dependencies();
    deps.speech.synthesize.mockRejectedValue(new VoiceMessageProviderError(
      "AGENT_VOICE_MESSAGE_PROVIDER_PAYMENT_REQUIRED",
      "В ElevenLabs закончились кредиты или для голоса нужен платный тариф",
      "definitive",
    ));
    const tool = createSendVoiceMessageTool(deps as never);

    const error = await failure(tool.execute(INPUT, context()));

    expect(error.contract).toMatchObject({
      category: "dependency",
      code: "AGENT_VOICE_MESSAGE_PROVIDER_PAYMENT_REQUIRED",
      reason: "В ElevenLabs закончились кредиты или для голоса нужен платный тариф",
      retryable: false,
      sideEffectStatus: "not_started",
    });
    expect(error.contract.correction).toMatch(/Не вызывай send_voice_message повторно/u);
    expect(error.contract.correction).toMatch(/обычным текстом/u);
    expect(deps.operations.markFailed).toHaveBeenCalledWith(
      CALL_ID,
      "AGENT_VOICE_MESSAGE_PROVIDER_PAYMENT_REQUIRED",
    );
    expect(deps.workspaces.writeBinary).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("records an unconfirmed synthesis as ambiguous without retrying", async () => {
    const deps = dependencies();
    deps.speech.synthesize.mockRejectedValue(new VoiceMessageProviderError(
      "AGENT_VOICE_MESSAGE_PROVIDER_STATUS_UNKNOWN",
      "Сервис озвучки ElevenLabs не ответил вовремя",
      "ambiguous",
    ));
    const tool = createSendVoiceMessageTool(deps as never);

    const error = await failure(tool.execute(INPUT, context()));

    expect(error.contract.sideEffectStatus).toBe("not_started");
    expect(deps.speech.synthesize).toHaveBeenCalledOnce();
    expect(deps.operations.markAmbiguous).toHaveBeenCalledWith(
      CALL_ID,
      "AGENT_VOICE_MESSAGE_PROVIDER_STATUS_UNKNOWN",
    );
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("delivers a completed replay without synthesizing again", async () => {
    const deps = dependencies();
    deps.operations.begin.mockResolvedValue({ file: FILE, state: "completed" });
    const tool = createSendVoiceMessageTool(deps as never);

    await expect(tool.execute(INPUT, context())).resolves.toMatchObject({
      generated: false,
      path: VOICE_PATH,
    });
    expect(deps.speech.synthesize).not.toHaveBeenCalled();
    expect(deps.workspaces.writeBinary).not.toHaveBeenCalled();
    expect(deps.recordingStatus).not.toHaveBeenCalled();
    expect(deps.deliver).toHaveBeenCalledOnce();
  });

  it("recovers a written voice note after a crash before ledger completion", async () => {
    const deps = dependencies();
    deps.operations.begin.mockResolvedValue({ state: "started", workspaceId: "workspace-1" });
    deps.workspaces.findBinaryWrite.mockResolvedValue(FILE);
    const tool = createSendVoiceMessageTool(deps as never);

    await expect(tool.execute(INPUT, context())).resolves.toMatchObject({ generated: false });
    expect(deps.speech.synthesize).not.toHaveBeenCalled();
    expect(deps.operations.complete).toHaveBeenCalledWith(CALL_ID, FILE, null);
    expect(deps.deliver).toHaveBeenCalledOnce();
  });

  it("rejects completed metadata that does not match the reserved output", async () => {
    const deps = dependencies();
    deps.operations.begin.mockResolvedValue({
      file: { ...FILE, mediaType: "audio/mpeg" },
      state: "completed",
    });
    const tool = createSendVoiceMessageTool(deps as never);

    const error = await failure(tool.execute(INPUT, context()));

    expect(error.contract.code).toBe("AGENT_VOICE_MESSAGE_REPLAY_MISMATCH");
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it.each([
    { errorCode: "AGENT_VOICE_MESSAGE_PROVIDER_STATUS_UNKNOWN", state: "ambiguous" as const },
    { errorCode: "AGENT_VOICE_MESSAGE_PROVIDER_REJECTED", state: "failed" as const },
  ])("does not synthesize again for a terminal $state reservation", async (reservation) => {
    const deps = dependencies();
    deps.operations.begin.mockResolvedValue(reservation);
    const tool = createSendVoiceMessageTool(deps as never);

    const error = await failure(tool.execute(INPUT, context()));

    expect(error.contract).toMatchObject({ retryable: false, sideEffectStatus: "not_started" });
    expect(error.contract.correction).toMatch(/обычным текстом/u);
    expect(deps.speech.synthesize).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("marks a failed workspace write ambiguous after the credits were spent", async () => {
    const deps = dependencies();
    deps.workspaces.writeBinary.mockRejectedValue(new Error("disk unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tool = createSendVoiceMessageTool(deps as never);

    const error = await failure(tool.execute(INPUT, context()));

    expect(error.contract).toMatchObject({
      code: "AGENT_VOICE_MESSAGE_STATUS_UNKNOWN",
      sideEffectStatus: "not_started",
    });
    expect(deps.operations.markAmbiguous).toHaveBeenCalledWith(
      CALL_ID,
      "AGENT_VOICE_MESSAGE_STATUS_UNKNOWN",
    );
    expect(deps.deliver).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("reports an unconfirmed Telegram delivery as possibly delivered", async () => {
    const deps = dependencies();
    deps.deliver.mockRejectedValue(new AppError(
      "AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS",
      "Не удалось подтвердить отправку файла. Проверьте чат перед повторным запросом",
    ));
    const tool = createSendVoiceMessageTool(deps as never);

    const error = await failure(tool.execute(INPUT, context()));

    expect(error.contract).toMatchObject({
      code: "AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS",
      retryable: false,
      sideEffectStatus: "unknown",
    });
    expect(error.contract.correction).toMatch(/могло дойти/u);
  });

  it("redirects to text when the recipient forbids voice messages", async () => {
    const deps = dependencies();
    deps.deliver.mockRejectedValue(new AppError(
      "AGENT_TELEGRAM_VOICE_FORBIDDEN",
      "Получатель запретил голосовые сообщения в настройках приватности Telegram",
    ));
    const tool = createSendVoiceMessageTool(deps as never);

    const error = await failure(tool.execute(INPUT, context()));

    expect(error.contract).toMatchObject({
      code: "AGENT_TELEGRAM_VOICE_FORBIDDEN",
      reason: "Получатель запретил голосовые сообщения в настройках приватности Telegram",
      sideEffectStatus: "not_started",
    });
    expect(error.contract.correction).toMatch(/обычным текстом/u);
  });
});
