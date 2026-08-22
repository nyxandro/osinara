/**
 * Model-facing subscription image generation tool tests.
 *
 * Constructs covered:
 * - One successful generation is persisted and delivered as a Telegram photo.
 * - Completed and filesystem-recoverable calls never charge the subscription twice.
 * - Definitive and ambiguous provider outcomes become terminal durable operation states.
 * - The provider gate is asserted separately, so this suite runs the Codex-subscription runtime.
 */
import { createHash } from "node:crypto";

import type { ToolContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";

vi.mock("./image-generation/image-generation-availability.js", () => ({
  IMAGE_GENERATION_AVAILABLE: true,
}));

import { AppError } from "./app-error.js";
import { createGenerateImageTool } from "./tools/generate_image.js";

const GENERATED_PATH = `generated-images/image-${createHash("sha256")
  .update("call-image-1", "utf8")
  .digest("hex")
  .slice(0, 24)}.webp`;
const FILE = {
  byteSize: 12,
  contentSha256: "a".repeat(64),
  mediaType: "image/webp",
  path: GENERATED_PATH,
  scope: "group" as const,
  updatedAt: "2026-08-21T00:00:00.000Z",
};
const INPUT = {
  background: "opaque" as const,
  caption: "Готовая иллюстрация",
  prompt: "A clean editorial illustration of a shared calendar",
  quality: "high" as const,
  scope: "group" as const,
  size: "1536x1024" as const,
};

function context(): ToolContext {
  return {
    callId: "call-image-1",
    session: {
      auth: {
        current: {
          attributes: {
            familyId: "family-1",
            groupId: "group-1",
            groupType: "external",
            role: "external",
            telegramChatId: "-1001",
            telegramChatType: "supergroup",
          },
          authenticator: "telegram",
          principalId: "telegram:101",
          principalType: "user",
        },
        initiator: null,
      },
      id: "wrun-image",
      turn: { id: "turn-image", sequence: 1 },
    },
  } as unknown as ToolContext;
}

function dependencies() {
  return {
    client: {
      generate: vi.fn().mockResolvedValue({
        bytes: Buffer.from("generated"),
        mediaType: "image/webp",
        model: "gpt-image-2",
        revisedPrompt: "Revised prompt",
      }),
    },
    deliver: vi.fn().mockResolvedValue({
      delivered: true,
      path: FILE.path,
      persistenceCompleted: true,
      projectionCompleted: true,
      replayed: false,
      retryable: false,
      scope: "group",
      sideEffectStatus: "completed",
      telegramMessageId: "77",
    }),
    operations: {
      begin: vi.fn().mockResolvedValue({ state: "execute", workspaceId: "workspace-1" }),
      complete: vi.fn().mockResolvedValue(undefined),
      markAmbiguous: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
    },
    workspaces: {
      findBinaryWrite: vi.fn().mockResolvedValue(null),
      workspaceId: vi.fn().mockResolvedValue("workspace-1"),
      writeBinary: vi.fn().mockImplementation(async (
        _auth: unknown,
        input: { path: string; scope: "family" | "group" | "personal" },
      ) => ({
        ...FILE,
        path: input.path,
        scope: input.scope,
      })),
    },
  };
}

describe("generate_image", () => {
  it("generates, stores, and delivers one authorized image", async () => {
    const deps = dependencies();
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context())).resolves.toMatchObject({
      delivered: true,
      generated: true,
      model: "gpt-image-2",
      path: expect.stringMatching(/^generated-images\/image-[0-9a-f]{24}\.webp$/u),
      revisedPrompt: "Revised prompt",
      telegramMessageId: "77",
    });
    expect(deps.client.generate).toHaveBeenCalledTimes(1);
    expect(deps.workspaces.writeBinary).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        bytes: Buffer.from("generated"),
        mediaType: "image/webp",
        operationKey: "call-image-1",
        scope: "group",
      }),
    );
    expect(deps.operations.complete).toHaveBeenCalledWith(
      "call-image-1",
      expect.objectContaining({
        path: expect.stringMatching(/^generated-images\/image-[0-9a-f]{24}\.webp$/u),
        scope: "group",
      }),
    );
    expect(deps.deliver).toHaveBeenCalledWith({
      caption: "Готовая иллюстрация",
      path: expect.stringMatching(/^generated-images\/image-[0-9a-f]{24}\.webp$/u),
      presentation: "photo",
      scope: "group",
    }, expect.anything());
  });

  it("delivers a completed replay without generating or writing again", async () => {
    const deps = dependencies();
    deps.operations.begin.mockResolvedValue({ file: FILE, state: "completed" });
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context())).resolves.toMatchObject({
      generated: false,
      path: FILE.path,
    });
    expect(deps.client.generate).not.toHaveBeenCalled();
    expect(deps.workspaces.writeBinary).not.toHaveBeenCalled();
    expect(deps.deliver).toHaveBeenCalledTimes(1);
  });

  it("rejects completed metadata that does not match the reserved output", async () => {
    const deps = dependencies();
    deps.operations.begin.mockResolvedValue({
      file: { ...FILE, scope: "personal" },
      state: "completed",
    });
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context()))
      .rejects.toThrowError(/AGENT_IMAGE_GENERATION_REPLAY_MISMATCH/u);
    expect(deps.client.generate).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("recovers a written file after a crash before ledger completion", async () => {
    const deps = dependencies();
    deps.operations.begin.mockResolvedValue({ state: "started", workspaceId: "workspace-1" });
    deps.workspaces.findBinaryWrite.mockResolvedValue(FILE);
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context())).resolves.toMatchObject({
      generated: false,
      path: FILE.path,
    });
    expect(deps.client.generate).not.toHaveBeenCalled();
    expect(deps.operations.complete).toHaveBeenCalledWith("call-image-1", FILE);
  });

  it("records a rejected prompt as a definitive failure", async () => {
    const deps = dependencies();
    deps.client.generate.mockRejectedValue(new AppError(
      "AGENT_IMAGE_GENERATION_REJECTED",
      "Сервис генерации изображений отклонил запрос. Измените описание и попробуйте снова",
    ));
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context())).rejects.toThrowError(/AGENT_IMAGE_GENERATION_REJECTED/u);
    expect(deps.operations.markFailed).toHaveBeenCalledWith(
      "call-image-1",
      "AGENT_IMAGE_GENERATION_REJECTED",
    );
    expect(deps.workspaces.writeBinary).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("records uncertain provider completion as ambiguous without retrying", async () => {
    const deps = dependencies();
    deps.client.generate.mockRejectedValue(new AppError(
      "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
      "Не удалось подтвердить результат генерации. Создайте новый запрос позднее",
    ));
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context())).rejects.toThrowError(/AGENT_IMAGE_GENERATION_STATUS_UNKNOWN/u);
    expect(deps.client.generate).toHaveBeenCalledTimes(1);
    expect(deps.operations.markAmbiguous).toHaveBeenCalledWith(
      "call-image-1",
      "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
    );
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("marks a failed workspace write ambiguous after provider completion", async () => {
    const deps = dependencies();
    deps.workspaces.writeBinary.mockRejectedValue(new Error("disk unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context()))
      .rejects.toThrowError(/AGENT_IMAGE_GENERATION_STATUS_UNKNOWN/u);
    expect(deps.operations.markAmbiguous).toHaveBeenCalledWith(
      "call-image-1",
      "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
    );
    expect(deps.deliver).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("recovers a written image when only ledger completion failed", async () => {
    const deps = dependencies();
    deps.operations.complete.mockRejectedValueOnce(new Error("database unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context()))
      .rejects.toThrowError(/AGENT_IMAGE_GENERATION_STATUS_UNKNOWN/u);
    expect(deps.operations.markAmbiguous).not.toHaveBeenCalled();

    deps.operations.begin.mockResolvedValue({ state: "started", workspaceId: "workspace-1" });
    deps.workspaces.findBinaryWrite.mockResolvedValue(FILE);
    await expect(tool.execute(INPUT, context())).resolves.toMatchObject({
      generated: false,
      path: FILE.path,
    });
    expect(deps.client.generate).toHaveBeenCalledTimes(1);
    expect(deps.operations.complete).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it.each([
    { errorCode: "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN", state: "ambiguous" as const },
    { errorCode: "AGENT_IMAGE_GENERATION_REJECTED", state: "failed" as const },
  ])("does not regenerate a terminal $state reservation", async (reservation) => {
    const deps = dependencies();
    deps.operations.begin.mockResolvedValue(reservation);
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context())).rejects.toThrowError(
      new RegExp(reservation.errorCode, "u"),
    );
    expect(deps.client.generate).not.toHaveBeenCalled();
    expect(deps.workspaces.writeBinary).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
  });
});
