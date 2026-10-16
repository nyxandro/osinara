/**
 * Model-facing Telegram group history authorization tests.
 *
 * Constructs covered:
 * - `requireTelegramGroupHistoryAuthorization`: derives group identity only from verified auth.
 * - `searchTelegramGroupHistory`: forwards bounded filters without accepting a model scope.
 * - External history exposes attachment references only for current live media capabilities.
 * - Date filters fail fast even when this boundary is called without the model schema.
 * - The tool schema and every group mode teach exact, sequential history retrieval.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import listGroupHistory from "./tools/list_group_history.js";
import { AppError } from "./app-error.js";
import { modeInstructions } from "./prompt/mode-instructions.js";
import {
  requireTelegramGroupHistoryAuthorization,
  searchTelegramGroupHistory,
} from "./telegram-group-history.js";

function context(attributes: Record<string, unknown>) {
  return { session: { auth: { current: {
    attributes,
    authenticator: "telegram",
    principalId: "user-1",
    principalType: "user",
  } } } } as never;
}

describe("Telegram group history", () => {
  it("teaches exact filter and pagination semantics in the model-facing schema", () => {
    const description = listGroupHistory.description;
    const schema = z.toJSONSchema(
      listGroupHistory.inputSchema as unknown as z.ZodType,
    ) as {
      properties?: Record<string, { description?: string }>;
    };

    expect(description).toContain("not a semantic search");
    expect(description).toContain("combined with AND");
    expect(description).toContain("one call per model step");
    expect(description).toContain('{"beforeSequence":"320","limit":3}');
    expect(schema.properties?.query?.description).toContain("literal substring");
    expect(schema.properties?.participant?.description).toContain("exact username");
    expect(schema.properties?.beforeSequence?.description).toContain("strictly less");
    expect(schema.properties?.sequenceFrom?.description).toContain("inclusive");
    expect(schema.properties?.sequenceTo?.description).toContain("inclusive");
    expect(schema.properties?.from?.description).toContain("inclusive");
    expect(schema.properties?.to?.description).toContain("inclusive");
    expect(schema.properties?.limit?.description).toContain("after all filters");
  });

  it.each([
    ["family", modeInstructions({ environment: "family" })],
    [
      "external with granted history",
      modeInstructions({
        capabilities: new Set(["list_group_history"]),
        environment: "external",
      }),
    ],
  ] as const)("forbids parallel history calls in the %s mode instructions", (_mode, instructions) => {
    expect(instructions).toContain("Do not call `list_group_history` several times in parallel");
    expect(instructions).toContain("wait for the result of the current call");
    expect(instructions).toContain("do not attribute a result to another set of filters");
  });

  it("uses the whole current verified family group without exposing a model scope", () => {
    expect(requireTelegramGroupHistoryAuthorization(context({
      groupId: "group-1",
      groupType: "family_private",
      telegramForumTopicId: "77",
    }))).toEqual({ familyId: null, groupId: "group-1", groupType: "family_private" });
  });

  it("fails closed outside a verified Telegram group", () => {
    expect(() => requireTelegramGroupHistoryAuthorization(context({
      telegramChatType: "private",
    }))).toThrowError(AppError);
    expect(() => requireTelegramGroupHistoryAuthorization(context({
      groupId: "group-1",
      groupType: "external",
    }))).toThrowError(AppError);
  });

  it("passes practical bounded filters to the repository", async () => {
    const repository = { search: vi.fn().mockResolvedValue({ entries: [], nextBeforeSequence: null }) };

    await searchTelegramGroupHistory(repository, { query: "ужин", limit: 20 }, context({
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
    }), vi.fn().mockResolvedValue(new Set(["list_group_history"])));

    expect(repository.search).toHaveBeenCalledWith(expect.objectContaining({
      allTopics: true,
      groupId: "group-1",
      limit: 20,
      messageThreadId: null,
      query: "ужин",
    }));
  });

  it("removes external attachment metadata when current live media grants are absent", async () => {
    const repository = {
      search: vi.fn().mockResolvedValue({
        entries: [
          {
            actorId: "user-1",
            actorKind: "user",
            attachment: {
              attachmentId: "attachment-1",
              fileName: "notes.md",
              kind: "document",
              mediaType: "text/markdown",
            },
            contentText: "Документ",
            messageKind: "document",
            messageThreadId: null,
            replyToSequenceId: null,
            senderDisplayName: "Участник",
            senderUsername: "member",
            sentAt: "2026-08-09T10:00:00.000Z",
            sequenceId: "10",
          },
        ],
        nextBeforeSequence: null,
      }),
    };
    const loadCapabilities = vi.fn().mockResolvedValue(new Set(["list_group_history"]));

    const result = await searchTelegramGroupHistory(
      repository,
      {},
      context({ familyId: "family-1", groupId: "group-1", groupType: "external" }),
      loadCapabilities,
    );

    expect(result.entries[0]).not.toHaveProperty("attachment");
    expect(loadCapabilities).toHaveBeenCalledWith({ familyId: "family-1", groupId: "group-1" });
  });

  it("keeps family attachment metadata without consulting the external policy", async () => {
    const repository = {
      search: vi.fn().mockResolvedValue({
        entries: [{
          actorId: "user-1",
          actorKind: "user",
          attachment: {
            attachmentId: "attachment-1",
            fileName: "archive.zip",
            kind: "document",
            mediaType: "application/zip",
          },
          contentText: null,
          messageKind: "document",
          messageThreadId: null,
          replyToSequenceId: null,
          senderDisplayName: "Участник",
          senderUsername: "member",
          sentAt: "2026-08-09T10:00:00.000Z",
          sequenceId: "10",
        }],
        nextBeforeSequence: null,
      }),
    };
    const loadCapabilities = vi.fn();

    const result = await searchTelegramGroupHistory(
      repository,
      {},
      context({ groupId: "group-1", groupType: "family_private" }),
      loadCapabilities,
    );

    expect(result.entries[0]).toHaveProperty("attachment.attachmentId", "attachment-1");
    expect(loadCapabilities).not.toHaveBeenCalled();
  });

  it("keeps only attachment classes allowed by the current external policy", async () => {
    const baseEntry = {
      actorId: "user-1",
      actorKind: "user" as const,
      contentText: null,
      messageKind: "document",
      messageThreadId: null,
      replyToSequenceId: null,
      senderDisplayName: "Участник",
      senderUsername: "member",
      sentAt: "2026-08-09T10:00:00.000Z",
    };
    const repository = {
      search: vi.fn().mockResolvedValue({
        entries: [
          {
            ...baseEntry,
            attachment: {
              attachmentId: "attachment-text",
              fileName: "notes.md",
              kind: "document",
              mediaType: "text/markdown",
            },
            sequenceId: "10",
          },
          {
            ...baseEntry,
            attachment: {
              attachmentId: "attachment-photo",
              fileName: "photo.jpg",
              kind: "photo",
              mediaType: "image/jpeg",
            },
            messageKind: "photo",
            sequenceId: "11",
          },
        ],
        nextBeforeSequence: null,
      }),
    };

    const result = await searchTelegramGroupHistory(
      repository,
      {},
      context({ familyId: "family-1", groupId: "group-1", groupType: "external" }),
      vi.fn().mockResolvedValue(new Set(["import_telegram_attachment", "list_group_history"])),
    );

    expect(result.entries[0]).toHaveProperty("attachment.attachmentId", "attachment-text");
    expect(result.entries[1]).not.toHaveProperty("attachment");
  });

  it("rejects an invalid date before querying the repository", async () => {
    const repository = { search: vi.fn() };
    const loadCapabilities = vi.fn();

    await expect(searchTelegramGroupHistory(
      repository,
      { from: "not-a-date" },
      context({ familyId: "family-1", groupId: "group-1", groupType: "external" }),
      loadCapabilities,
    )).rejects.toMatchObject({
      code: "AGENT_GROUP_HISTORY_DATE_INVALID",
    });
    expect(loadCapabilities).not.toHaveBeenCalled();
    expect(repository.search).not.toHaveBeenCalled();
  });
});
