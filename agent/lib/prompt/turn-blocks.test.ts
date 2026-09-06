/**
 * Turn-scoped prompt block resolution tests.
 *
 * Constructs covered:
 * - Eve retains a previous turn's block when a resolver throws, so resolvers must never throw.
 * - An unresolvable environment produces an explicit fail-closed block, not a stale one.
 * - A failed external capability lookup degrades to an empty allowlist, matching execution policy.
 * - Scheduled-history instructions require the same successful application-core policy lookup.
 * - Unavailable memory is disclosed instead of looking like an empty result set.
 */
import type { SessionAuth, SessionAuthContext } from "eve/context";
import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import type { ExternalGroupToolName } from "../tool-policy/group-tool-catalog.js";
import {
  createMemoryBlockResolver,
  createModeBlockResolver,
  createPreferenceBlockResolver,
  createReactionSetBlockResolver,
} from "./turn-blocks.js";
import { formatReactionSetAnnouncement } from "../telegram-reaction-announcement.js";
import { TELEGRAM_DEFAULT_REACTIONS } from "../telegram-reaction-set.js";

const createProfile = vi.fn();
const TEST_TURN_ID = "turn-1";

function auth(attributes: SessionAuthContext["attributes"]): SessionAuth {
  return {
    current: {
      attributes,
      authenticator: "telegram",
      principalId: "user-1",
      principalType: "user",
    },
    initiator: null,
  };
}

function context(sessionAuth: SessionAuth, messages: readonly ModelMessage[] = []) {
  return { messages, session: { auth: sessionAuth, id: "session-1" } };
}

const privateAuth = auth({
  memoryScopes: ["personal", "family"],
  telegramActorId: "101",
  telegramActorKind: "telegram_user",
  telegramChatType: "private",
  telegramUserId: "101",
});

const externalAuth = auth({
  familyId: "family-1",
  groupId: "group-1",
  groupType: "external",
  memoryScopes: ["group"],
  role: "external",
  telegramActorId: "101",
  telegramActorKind: "telegram_user",
  telegramChatType: "supergroup",
  telegramUserId: "101",
  toolAllowlist: ["remember"],
});

const channelAuth: SessionAuth = {
  current: {
    attributes: {
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
      memoryScopes: ["group"],
      role: "external",
      skillAllowlist: ["pohuy"],
      telegramActorId: "-1001783384254",
      telegramActorKind: "telegram_channel",
      telegramChatType: "supergroup",
      toolAllowlist: ["remember"],
    },
    authenticator: "telegram",
    principalId: "telegram-channel:-1001783384254",
    principalType: "service",
  },
  initiator: null,
};

const reactionPolicy = vi.fn().mockResolvedValue(null);

describe("mode block resolution", () => {
  it("resolves the verified profile for a trusted conversation", async () => {
    const resolve = createModeBlockResolver({
      loadCapabilities: vi.fn(),
      loadReactionPolicy: reactionPolicy,
      loadSkills: vi.fn(),
    });

    const markdown = await resolve(context(privateAuth));

    expect(markdown).toContain("# Текущий режим: личный чат");
  });

  it("returns an explicit fail-closed block instead of throwing on invalid auth", async () => {
    const resolve = createModeBlockResolver({
      loadCapabilities: vi.fn(),
      loadReactionPolicy: reactionPolicy,
      loadSkills: vi.fn(),
    });

    const markdown = await resolve(context({ current: null, initiator: null }));

    expect(markdown).toContain("AGENT_CONVERSATION_ENVIRONMENT_INVALID");
    expect(markdown).toContain("<current_conversation_environment>");
    expect(markdown).not.toContain("# Текущий режим: личный чат");
  });

  it("degrades to an empty allowlist when the live capability lookup fails", async () => {
    const loadCapabilities = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const resolve = createModeBlockResolver({
      loadCapabilities,
      loadReactionPolicy: reactionPolicy,
      loadSkills: vi.fn().mockResolvedValue(new Set()),
    });

    const markdown = await resolve(context(externalAuth));

    expect(markdown).toContain("<external_group_capabilities>");
    expect(markdown).not.toContain("`remember`");
  });

  it("omits scheduled-history instructions when application-core policy lookup fails", async () => {
    const current = auth({
      ...externalAuth.current!.attributes,
      scheduledGroupHistory: "enabled",
      scheduledRunId: "run-1",
    });
    const scheduledAuth = { ...current, initiator: current.current };
    const resolve = createModeBlockResolver({
      loadCapabilities: vi.fn().mockRejectedValue(new Error("database unavailable")),
      loadReactionPolicy: reactionPolicy,
      loadSkills: vi.fn().mockResolvedValue(new Set()),
    });

    const markdown = await resolve(context(scheduledAuth));

    expect(markdown).not.toContain("read_scheduled_group_history");
  });

  it("includes scheduled-history instructions after application-core policy resolves", async () => {
    const current = auth({
      ...externalAuth.current!.attributes,
      scheduledGroupHistory: "enabled",
      scheduledRunId: "run-1",
    });
    const scheduledAuth = { ...current, initiator: current.current };
    const resolve = createModeBlockResolver({
      loadCapabilities: vi.fn().mockResolvedValue(new Set()),
      loadReactionPolicy: reactionPolicy,
      loadSkills: vi.fn().mockResolvedValue(new Set()),
    });

    const markdown = await resolve(context(scheduledAuth));

    expect(markdown).toContain("read_scheduled_group_history");
  });

  it("omits a capability revoked from the current database policy", async () => {
    const loadCapabilities = vi.fn().mockResolvedValue(new Set<ExternalGroupToolName>());
    const resolve = createModeBlockResolver({
      loadCapabilities,
      loadReactionPolicy: reactionPolicy,
      loadSkills: vi.fn().mockResolvedValue(new Set()),
    });

    const markdown = await resolve(context(externalAuth));

    expect(loadCapabilities).toHaveBeenCalledWith({ familyId: "family-1", groupId: "group-1" });
    expect(markdown).not.toContain("`remember`");
  });

  it("intersects the verified snapshot with the current database policy", async () => {
    const loadCapabilities = vi.fn().mockResolvedValue(
      new Set<ExternalGroupToolName>(["remember", "web_fetch"]),
    );
    const resolve = createModeBlockResolver({
      loadCapabilities,
      loadReactionPolicy: reactionPolicy,
      loadSkills: vi.fn().mockResolvedValue(new Set()),
    });

    const markdown = await resolve(context(externalAuth));

    expect(markdown).toContain("`remember`");
    expect(markdown).toContain("`web_fetch`");
  });

  it("matches the external skill prompt to the current persisted grants", async () => {
    const loadSkills = vi.fn().mockResolvedValue(new Set(["pohuy"]));
    const resolve = createModeBlockResolver({
      loadCapabilities: vi.fn().mockResolvedValue(new Set()),
      loadReactionPolicy: reactionPolicy,
      loadSkills,
    });

    const markdown = await resolve(context(externalAuth));

    expect(loadSkills).toHaveBeenCalledWith("group-1");
    expect(markdown).toContain("`load_skill` с `skill=pohuy`");
  });

  it("does not describe human capabilities or skills to a channel actor", async () => {
    const loadCapabilities = vi.fn().mockResolvedValue(new Set(["remember"]));
    const loadSkills = vi.fn().mockResolvedValue(new Set(["pohuy"]));
    const resolve = createModeBlockResolver({
      loadCapabilities,
      loadReactionPolicy: reactionPolicy,
      loadSkills,
    });

    const markdown = await resolve(context(channelAuth));

    expect(loadCapabilities).not.toHaveBeenCalled();
    expect(loadSkills).not.toHaveBeenCalled();
    // The text-only channel surface must not gain a reaction it could apply to a channel post.
    expect(reactionPolicy).not.toHaveBeenCalled();
    expect(markdown).not.toContain("## Реакция вместо сообщения");
    expect(markdown).not.toContain("`remember`");
    expect(markdown).not.toContain("`load_skill`");
  });
});

describe("memory block resolution", () => {
  const authorization = {
    familyId: "family-1",
    groupId: null,
    role: "owner" as const,
    scopes: ["personal" as const, "family" as const],
    telegramActorId: "101",
    telegramActorKind: "telegram_user" as const,
    telegramUserId: "101",
    userId: "user-1",
  };

  it("returns retrieved records for an authorized turn", async () => {
    const resolve = createMemoryBlockResolver({
      authorize: () => authorization,
      createProfile,
      retrieve: vi.fn().mockResolvedValue({
        memories: [],
        retrievedClaimIds: [],
        threads: { threads: [], totalCharacters: 0 },
      }),
    });

    const markdown = await resolve(
      context(privateAuth, [{ content: "что купить?", role: "user" }] as ModelMessage[]),
      TEST_TURN_ID,
    );

    expect(markdown).toContain("Записи отобраны сервером");
  });

  it("returns no block when the turn carries no user text", async () => {
    const retrieve = vi.fn();
    const resolve = createMemoryBlockResolver({ authorize: () => authorization, createProfile, retrieve });

    expect(await resolve(context(privateAuth), TEST_TURN_ID)).toBeNull();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("discloses unavailable memory instead of throwing on authorization failure", async () => {
    const resolve = createMemoryBlockResolver({
      authorize: () => {
        throw new Error("AGENT_MEMORY_CONTEXT_INVALID: нет области памяти");
      },
      createProfile,
      retrieve: vi.fn(),
    });

    const markdown = await resolve(
      context(privateAuth, [{ content: "что купить?", role: "user" }] as ModelMessage[]),
      TEST_TURN_ID,
    );

    expect(markdown).toContain("AGENT_MEMORY_UNAVAILABLE");
    expect(markdown).not.toContain("активный pipeline текущей реализации");
  });

  it("discloses unavailable memory instead of throwing on retrieval failure", async () => {
    const resolve = createMemoryBlockResolver({
      authorize: () => authorization,
      createProfile,
      retrieve: vi.fn().mockRejectedValue(new Error("embedding service down")),
    });

    const markdown = await resolve(
      context(privateAuth, [{ content: "что купить?", role: "user" }] as ModelMessage[]),
      TEST_TURN_ID,
    );

    expect(markdown).toContain("AGENT_MEMORY_UNAVAILABLE");
  });

  it("builds the same-turn profile from verified signals and retrieval-related claim identities", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      memories: [],
      retrievedClaimIds: ["claim-related"],
      threads: { threads: [], totalCharacters: 0 },
    });
    const profile = vi.fn().mockResolvedValue({
      generatedAt: "2026-08-08T10:00:00.000Z",
      profileViewRef: "view_11111111111111111111111111111111",
      subjects: [{
        claims: [],
        label: "Пётр",
        priority: "retrieval_related",
        subjectRef: "subj_11111111111111111111111111111111",
        totalCharacters: 0,
      }],
      totalCharacters: 0,
    });
    const resolve = createMemoryBlockResolver({
      authorize: () => authorization,
      createProfile: profile,
      retrieve,
    });
    const telegramAuth = auth({
      memoryScopes: ["personal", "family"],
      telegramConversationId: "conversation-1",
      telegramProfileMentionUserIds: ["202"],
      telegramProfileReplyUserId: "203",
      telegramProfileReplyTimelineSequence: "44",
      telegramTurnStartedAt: "2026-08-08T10:00:00.000Z",
      telegramUserId: "101",
    });

    const markdown = await resolve(
      context(telegramAuth, [{ content: "что любит Пётр?", role: "user" }] as ModelMessage[]),
      TEST_TURN_ID,
    );

    expect(profile).toHaveBeenCalledWith(authorization, {
      conversationId: "conversation-1",
      currentTelegramUserId: "101",
      explicitMentionTelegramUserIds: ["202"],
      now: new Date("2026-08-08T10:00:00.000Z"),
      provenance: { sessionId: "session-1", turnId: TEST_TURN_ID },
      replyTelegramUserId: "203",
      replyTimelineSequence: "44",
      retrievalClaimIds: ["claim-related"],
      suppressCurrentAuthor: false,
    });
    expect(markdown).toContain("<verified_profile_view");
    expect(markdown).toContain('"priority":"retrieval_related"');
  });
});

describe("preference block resolution", () => {
  it("renders the one user-managed prompt of the current chat", async () => {
    const resolve = createPreferenceBlockResolver({
      authorize: () => ({
        conversationId: "conversation-1",
        sourceSequence: "1",
        telegramUserId: "101",
        timelineEntryId: "entry-1",
      }),
      get: vi.fn().mockResolvedValue({
        content: "Не добавляй шутки.",
        revision: 2,
        updatedAt: "2026-08-01T00:00:00.000Z",
      }),
    });

    const markdown = await resolve(context(privateAuth));

    expect(markdown).toContain('<chat_operational_instructions revision="2">');
    expect(markdown).toContain("Не добавляй шутки.");
  });

  it("clears the block instead of throwing when preferences cannot be read", async () => {
    const resolve = createPreferenceBlockResolver({
      authorize: () => {
        throw new Error("AGENT_MEMORY_CONTEXT_INVALID: нет области памяти");
      },
      get: vi.fn(),
    });

    expect(await resolve(context(privateAuth))).toBeNull();
  });
});

const reactionAuth = auth({
  memoryScopes: ["personal", "family"],
  telegramActorId: "101",
  telegramActorKind: "telegram_user",
  telegramChatId: "101",
  telegramChatType: "private",
  telegramUserId: "101",
});

describe("reaction set block resolution", () => {
  it("announces the default set for a chat that added no restriction", async () => {
    const loadReactionPolicy = vi.fn().mockResolvedValue({ allowsAll: true, emoji: [] });
    const resolve = createReactionSetBlockResolver({ loadReactionPolicy });

    const announcement = await resolve(context(reactionAuth));

    expect(loadReactionPolicy).toHaveBeenCalledWith("101");
    expect(announcement).toBe(formatReactionSetAnnouncement(TELEGRAM_DEFAULT_REACTIONS));
  });

  it("announces exactly the narrowed list of a chat", async () => {
    const resolve = createReactionSetBlockResolver({
      loadReactionPolicy: vi.fn().mockResolvedValue({ allowsAll: false, emoji: ["👍", "🔥"] }),
    });

    expect(await resolve(context(reactionAuth)))
      .toBe(formatReactionSetAnnouncement(["👍", "🔥"]));
  });

  it("stays silent while the same announcement is still in history", async () => {
    const resolve = createReactionSetBlockResolver({
      loadReactionPolicy: vi.fn().mockResolvedValue({ allowsAll: false, emoji: ["👍", "🔥"] }),
    });
    const announced = formatReactionSetAnnouncement(["👍", "🔥"]);

    expect(await resolve({
      ...context(reactionAuth),
      messages: [{ content: announced, role: "user" }],
    })).toBeNull();
  });

  it("announces again when the set changed under an older announcement", async () => {
    const resolve = createReactionSetBlockResolver({
      loadReactionPolicy: vi.fn().mockResolvedValue({ allowsAll: false, emoji: ["👍"] }),
    });

    expect(await resolve({
      ...context(reactionAuth),
      messages: [{ content: formatReactionSetAnnouncement(["👍", "🔥"]), role: "user" }],
    })).toBe(formatReactionSetAnnouncement(["👍"]));
  });

  it.each([
    ["reactions turned off", { allowsAll: false, emoji: [] }],
    ["unknown policy", null],
  ])("announces nothing for %s", async (_case, policy) => {
    const resolve = createReactionSetBlockResolver({
      loadReactionPolicy: vi.fn().mockResolvedValue(policy),
    });

    expect(await resolve(context(reactionAuth))).toBeNull();
  });

  it("announces nothing to a channel actor", async () => {
    const loadReactionPolicy = vi.fn();
    const resolve = createReactionSetBlockResolver({ loadReactionPolicy });

    expect(await resolve(context(channelAuth))).toBeNull();
    expect(loadReactionPolicy).not.toHaveBeenCalled();
  });

  it("discloses nothing instead of throwing when the lookup fails", async () => {
    const resolve = createReactionSetBlockResolver({
      loadReactionPolicy: vi.fn().mockRejectedValue(new Error("database unavailable")),
    });

    await expect(resolve(context(reactionAuth))).resolves.toBeNull();
  });
});
