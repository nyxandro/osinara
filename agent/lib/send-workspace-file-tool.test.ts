/**
 * Workspace file tool Telegram projection tests.
 *
 * Constructs covered:
 * - A confirmed group file delivery is projected into the timeline with session ownership.
 * - The exact Telegram media message receives a reply continuation route.
 * - Projection failures after confirmed delivery never invite a duplicate send.
 * - Delivery-journal failures after Telegram confirmation preserve completed side-effect semantics.
 */
import type { ToolContext } from "../runtime/tool.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "./app-error.js";

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  complete: vi.fn(),
  deliver: vi.fn(),
  fail: vi.fn(),
  recordAgentResponse: vi.fn(),
  registerTelegramMessageRoutes: vi.fn(),
}));

vi.mock("./attachments/telegram-workspace-file-delivery.js", () => ({
  deliverWorkspaceFile: mocks.deliver,
}));
vi.mock("./workspaces/workspace-file-delivery-repository.js", () => ({
  workspaceFileDeliveryRepository: {
    begin: mocks.begin,
    complete: mocks.complete,
    fail: mocks.fail,
  },
}));
vi.mock("./telegram-group-journal-repository.js", () => ({
  telegramGroupJournalRepository: { recordAgentResponse: mocks.recordAgentResponse },
}));
vi.mock("./sessions/session-context.js", () => ({
  applicationSessionId: () => "app-session-1",
  registerTelegramMessageRoutes: mocks.registerTelegramMessageRoutes,
}));

import sendWorkspaceFile from "./tools/send_workspace_file.js";

function context(): ToolContext {
  const caller = {
    attributes: {
      applicationSessionId: "app-session-1",
      familyId: "family-1",
      groupId: "group-1",
      groupType: "family_private",
      role: "member",
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
      telegramForumTopicId: "42",
      telegramMessageThreadId: "42",
      telegramTimelineEntryId: "00000000-0000-4000-8000-000000000010",
    },
    authenticator: "telegram",
    principalId: "user-1",
    principalType: "user" as const,
  };
  return {
    callId: "call-1",
    session: {
      auth: { current: caller, initiator: caller },
      id: "agent-session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
  } as unknown as ToolContext;
}

describe("send_workspace_file group projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.begin.mockResolvedValue({
      bytes: Buffer.from("image"),
      file: {
        contentSha256: "sha256",
        mediaType: "image/png",
        path: "screens/facade.png",
        scope: "family",
        size: 5,
      },
      status: "reserved",
      workspaceId: "workspace-1",
    });
    mocks.deliver.mockResolvedValue({ telegramMessageId: "446" });
    mocks.recordAgentResponse.mockResolvedValue({ entryId: "entry-1", sequenceId: "20" });
  });

  it("records and routes a confirmed tool-delivered photo", async () => {
    await sendWorkspaceFile.execute({
      caption: "Фасад ресторана",
      path: "screens/facade.png",
      presentation: "photo",
      scope: "family",
    }, context());

    expect(mocks.complete).toHaveBeenCalledWith("call-1", "446");
    expect(mocks.recordAgentResponse).toHaveBeenCalledWith(expect.objectContaining({
      applicationSessionId: "app-session-1",
      attachment: expect.objectContaining({ fileName: "facade.png", kind: "photo" }),
      contentText: "Фасад ресторана",
      groupId: "group-1",
      messageThreadId: "42",
      telegramMessageIds: ["446"],
    }));
    expect(mocks.registerTelegramMessageRoutes).toHaveBeenCalledWith({
      applicationSessionId: "app-session-1",
      chatId: "-1001",
      messageIds: ["446"],
      messageThreadId: 42,
    });
  });

  it("repairs timeline and route projection when a confirmed delivery step replays", async () => {
    mocks.begin.mockResolvedValue({
      bytes: Buffer.from("image"),
      file: {
        contentSha256: "sha256",
        mediaType: "image/png",
        path: "screens/facade.png",
        scope: "family",
        size: 5,
      },
      status: "completed",
      telegramMessageId: "446",
      workspaceId: "workspace-1",
    });

    await expect(sendWorkspaceFile.execute({
      caption: "Фасад ресторана",
      path: "screens/facade.png",
      presentation: "photo",
      scope: "family",
    }, context())).resolves.toMatchObject({ delivered: true, replayed: true });

    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.recordAgentResponse).toHaveBeenCalled();
    expect(mocks.registerTelegramMessageRoutes).toHaveBeenCalled();
  });

  it("returns confirmed delivery with an explicit projection warning instead of throwing", async () => {
    mocks.recordAgentResponse.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(sendWorkspaceFile.execute({
      caption: "Фасад ресторана",
      path: "screens/facade.png",
      presentation: "photo",
      scope: "family",
    }, context())).resolves.toMatchObject({
      delivered: true,
      projectionCompleted: false,
      retryable: false,
      sideEffectStatus: "completed",
    });

    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.registerTelegramMessageRoutes).not.toHaveBeenCalled();
  });

  it("does not retry Telegram when durable completion fails after confirmed delivery", async () => {
    mocks.complete.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(sendWorkspaceFile.execute({
      path: "screens/facade.png",
      presentation: "photo",
      scope: "family",
    }, context())).resolves.toMatchObject({
      delivered: true,
      persistenceCompleted: false,
      retryable: false,
      sideEffectStatus: "completed",
      telegramMessageId: "446",
    });

    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it("keeps an ambiguous Telegram delivery reserved for explicit recovery", async () => {
    mocks.deliver.mockRejectedValueOnce(new AppError(
      "AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS",
      "Telegram не подтвердил отправку файла",
    ));

    await expect(sendWorkspaceFile.execute({
      path: "screens/facade.png",
      presentation: "photo",
      scope: "family",
    }, context())).rejects.toThrowError(/AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS/u);

    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it("validates the forum topic before starting an external delivery", async () => {
    const invalidContext = context();
    (invalidContext.session.auth.current!.attributes as Record<string, unknown>)
      .telegramForumTopicId = "0";

    await expect(sendWorkspaceFile.execute({
      path: "screens/facade.png",
      presentation: "photo",
      scope: "family",
    }, invalidContext)).rejects.toThrowError(/AGENT_TELEGRAM_FORUM_TOPIC_INVALID/u);

    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
  });
});
