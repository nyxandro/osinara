/**
 * Current-chat workspace file delivery projection tests.
 *
 * Constructs covered:
 * - A voice note is projected into the group timeline as its spoken text, not as a file attachment.
 * - A voice note replaces the final private reply, so it enters the private conversation timeline
 *   and receives a reply route like a channel-delivered answer.
 * - Ordinary private file deliveries keep their existing projection-free behavior.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  complete: vi.fn(),
  deliver: vi.fn(),
  fail: vi.fn(),
  recordConversationResponse: vi.fn(),
  recordGroupResponse: vi.fn(),
  registerTelegramMessageRoutes: vi.fn(),
}));

vi.mock("./telegram-workspace-file-delivery.js", () => ({
  deliverWorkspaceFile: mocks.deliver,
}));
vi.mock("../workspaces/workspace-file-delivery-repository.js", () => ({
  workspaceFileDeliveryRepository: {
    begin: mocks.begin,
    complete: mocks.complete,
    fail: mocks.fail,
  },
}));
vi.mock("../telegram-group-journal-repository.js", () => ({
  telegramGroupJournalRepository: { recordAgentResponse: mocks.recordGroupResponse },
}));
vi.mock("../conversation-timeline-repository.js", () => ({
  conversationTimelineRepository: { recordAgentResponse: mocks.recordConversationResponse },
}));
vi.mock("../sessions/session-context.js", () => ({
  applicationSessionId: () => "app-session-1",
  registerTelegramMessageRoutes: mocks.registerTelegramMessageRoutes,
}));

import { sendWorkspaceFileToCurrentChat } from "./workspace-file-chat-delivery.js";

const VOICE_PATH = "generated-voice/voice-1.ogg";

function context(chat: "family" | "private"): ToolContext {
  const attributes: Record<string, unknown> = chat === "family"
    ? {
      familyId: "family-1",
      groupId: "group-1",
      groupType: "family_private",
      role: "member",
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
      telegramTimelineEntryId: "00000000-0000-4000-8000-000000000010",
    }
    : {
      familyId: "family-1",
      role: "owner",
      telegramChatId: "101",
      telegramChatType: "private",
      telegramConversationId: "00000000-0000-4000-8000-000000000020",
      telegramTimelineEntryId: "00000000-0000-4000-8000-000000000021",
    };
  const caller = {
    attributes,
    authenticator: "telegram",
    principalId: "user-1",
    principalType: "user" as const,
  };
  return {
    callId: "call-voice-1",
    session: {
      auth: { current: caller, initiator: caller },
      id: "eve-session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
  } as unknown as ToolContext;
}

function reservation(path: string, mediaType: string, scope: "family" | "personal") {
  return {
    bytes: Buffer.from("bytes"),
    file: { contentSha256: "sha256", mediaType, path, scope, size: 5 },
    status: "reserved",
    workspaceId: "workspace-1",
  };
}

describe("sendWorkspaceFileToCurrentChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deliver.mockResolvedValue({ telegramMessageId: "501" });
    mocks.recordGroupResponse.mockResolvedValue({ entryId: "entry-1", sequenceId: "20" });
    mocks.recordConversationResponse.mockResolvedValue({ entryId: "entry-2", sequenceId: "21" });
  });

  it("projects a group voice note as its spoken text without a file attachment", async () => {
    mocks.begin.mockResolvedValue(reservation(VOICE_PATH, "audio/ogg; codecs=opus", "family"));

    await expect(sendWorkspaceFileToCurrentChat({
      path: VOICE_PATH,
      presentation: "voice",
      scope: "family",
      timelineText: "Голосовое сообщение: Привет всем!",
    }, context("family"))).resolves.toMatchObject({
      delivered: true,
      projectionCompleted: true,
      telegramMessageId: "501",
    });

    expect(mocks.deliver).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "-1001",
      fileName: "voice-1.ogg",
      mediaType: "audio/ogg; codecs=opus",
      presentation: "voice",
    }));
    const [projection] = mocks.recordGroupResponse.mock.calls[0]!;
    expect(projection).toMatchObject({
      contentText: "Голосовое сообщение: Привет всем!",
      groupId: "group-1",
      telegramMessageIds: ["501"],
    });
    expect(projection).not.toHaveProperty("attachment");
    expect(mocks.registerTelegramMessageRoutes).toHaveBeenCalledWith({
      applicationSessionId: "app-session-1",
      chatId: "-1001",
      messageIds: ["501"],
    });
    expect(mocks.recordConversationResponse).not.toHaveBeenCalled();
  });

  it("projects a private voice note like the final reply it replaces", async () => {
    mocks.begin.mockResolvedValue(reservation(VOICE_PATH, "audio/ogg; codecs=opus", "personal"));

    await expect(sendWorkspaceFileToCurrentChat({
      path: VOICE_PATH,
      presentation: "voice",
      scope: "personal",
      timelineText: "Голосовое сообщение: Привет!",
    }, context("private"))).resolves.toMatchObject({ projectionCompleted: true });

    expect(mocks.recordConversationResponse).toHaveBeenCalledWith(expect.objectContaining({
      applicationSessionId: "app-session-1",
      contentText: "Голосовое сообщение: Привет!",
      conversationId: "00000000-0000-4000-8000-000000000020",
      messageThreadId: null,
      replyToEntryId: "00000000-0000-4000-8000-000000000021",
      telegramMessageIds: ["501"],
    }));
    expect(mocks.registerTelegramMessageRoutes).toHaveBeenCalledWith({
      applicationSessionId: "app-session-1",
      chatId: "101",
      messageIds: ["501"],
    });
    expect(mocks.recordGroupResponse).not.toHaveBeenCalled();
  });

  it("reports a failed private voice projection without inviting a duplicate send", async () => {
    mocks.begin.mockResolvedValue(reservation(VOICE_PATH, "audio/ogg; codecs=opus", "personal"));
    mocks.recordConversationResponse.mockRejectedValueOnce(new Error("database unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(sendWorkspaceFileToCurrentChat({
      path: VOICE_PATH,
      presentation: "voice",
      scope: "personal",
      timelineText: "Голосовое сообщение: Привет!",
    }, context("private"))).resolves.toMatchObject({
      delivered: true,
      projectionCompleted: false,
      sideEffectStatus: "completed",
    });
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("keeps an ordinary private file delivery out of the conversation timeline", async () => {
    mocks.begin.mockResolvedValue(reservation("reports/result.pdf", "application/pdf", "personal"));

    await sendWorkspaceFileToCurrentChat({
      path: "reports/result.pdf",
      presentation: "document",
      scope: "personal",
    }, context("private"));

    expect(mocks.recordConversationResponse).not.toHaveBeenCalled();
    expect(mocks.recordGroupResponse).not.toHaveBeenCalled();
    expect(mocks.registerTelegramMessageRoutes).not.toHaveBeenCalled();
  });
});
