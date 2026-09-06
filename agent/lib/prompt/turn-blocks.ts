/**
 * Turn-scoped prompt block resolution.
 *
 * Exports:
 * - `TurnBlockContext`: the minimal Eve resolve context a block resolver reads.
 * - `createModeBlockResolver` / `resolveModeBlock`: verified mode rulebook for the current turn.
 * - `createReactionSetBlockResolver` / `resolveReactionSetBlock`: reaction set announced in history.
 * - `createMemoryBlockResolver` / `resolveMemoryBlock`: authorized long-term memory records.
 * - `createPreferenceBlockResolver` / `resolvePreferenceBlock`: one editable chat prompt.
 *
 * Key constructs:
 * - Eve keeps a previous turn's block when a dynamic resolver throws, and never clears the durable
 *   record on its own. Every resolver here therefore returns an explicit value instead of throwing:
 *   a fail-closed block where the model must stop, and `null` where an absent block is safe.
 */
import type { SessionAuth } from "eve/context";
import type { ModelMessage } from "ai";

import {
  requireBehaviorPreferenceReadAuthorization,
  type BehaviorPreferenceReadAuthorization,
} from "../behavior-preference-context.js";
import {
  buildBehaviorPreferenceInstructions,
  type ChatOperationalPrompt,
} from "../behavior-preferences.js";
import { behaviorPreferenceRepository } from "../behavior-preference-repository.js";
import { resolveConversationEnvironment } from "../conversation-environment.js";
import {
  requireMemoryAuthorization,
  type MemoryAuthorization,
} from "../memory-context.js";
import {
  formatRetrievedMemoryInstructions,
  MEMORY_USED_REMINDER,
  memoryRetrievalQuery,
  retrieveRelevantMemories,
  retrieveMemoryTurnContext,
  type MemoryTurnContext,
  type MemoryTurnContextOptions,
  type ModelMemoryContextItem,
} from "../memory-retrieval.js";
import { memoryContextExposureRepository } from "../memory-context-exposure-repository.js";
import { applicationThreadSkillHints } from "../memory-thread-activation.js";
import {
  formatProfileViewContext,
  profileViewRepository,
} from "../profile-view-repository.js";
import type { CreateProfileViewInput, ProfileView } from "../profile-view.js";
import { isTelegramChannelSession } from "../telegram-session-actor.js";
import {
  TELEGRAM_REACTION_POLICY_TTL_MILLISECONDS,
  type TelegramReactionPolicy,
} from "../telegram-reaction-policy.js";
import { resolveChatReactions } from "../telegram-reaction-set.js";
import {
  announcesReactionSet,
  formatReactionSetAnnouncement,
} from "../telegram-reaction-announcement.js";
import { telegramReactionPolicyRepository } from "../telegram-reaction-policy-repository.js";
import { loadCurrentExternalGroupCapabilities } from "../tool-policy/external-group-live-policy.js";
import type { ExternalGroupToolName } from "../tool-policy/group-tool-catalog.js";
import type { GroupSafeSkillName } from "../group-skills/group-skill-catalog.js";
import { groupSkillPolicyRepository } from "../group-skills/group-skill-repository.js";
import {
  resolveExternalGroupPolicyIdentity,
  resolveExternalGroupToolPolicy,
} from "../tool-policy/external-group-policy.js";
import { scheduledGroupHistoryAccess } from "../agent-schedules/scheduled-group-history-context.js";
import { isScheduledSession } from "../agent-schedules/scheduled-session.js";
import { modeInstructions } from "./mode-instructions.js";

export interface TurnBlockContext {
  readonly channel?: { readonly kind?: string };
  readonly messages: readonly ModelMessage[];
  readonly session: {
    readonly auth: SessionAuth;
    readonly id: string;
    readonly parent?: unknown;
  };
}

type CapabilityLoader = (identity: {
  familyId: string;
  groupId: string;
}) => Promise<ReadonlySet<ExternalGroupToolName>>;
type SkillLoader = (groupId: string) => Promise<ReadonlySet<GroupSafeSkillName>>;
type ReactionPolicyLoader = (telegramChatId: string) => Promise<TelegramReactionPolicy | null>;

interface EffectiveExternalCapabilities {
  capabilities: ReadonlySet<ExternalGroupToolName>;
  includeApplicationCore: boolean;
}

const MODE_UNAVAILABLE_BLOCK = `
<current_conversation_environment>
# Режим текущего чата не определён

Возможности этого чата подтвердить не удалось. Не используй память, workspace, учётные данные, инструменты и интеграции и не выполняй никаких действий.

Ответь пользователю ровно одним сообщением: AGENT_CONVERSATION_ENVIRONMENT_INVALID: Не удалось определить режим текущего чата. Отправьте сообщение ещё раз. Затем остановись.
</current_conversation_environment>
`.trim();

const MEMORY_UNAVAILABLE_BLOCK = [
  "AGENT_MEMORY_UNAVAILABLE: В этом ходу долговременная память недоступна.",
  "Не утверждай, что проверила память, и не делай вывод, что записей нет.",
  "Если ответ зависит от долговременной памяти, скажи, что она временно недоступна, и предложи повторить запрос позже.",
].join(" ");

function logBlockFailure(code: string, error: unknown): void {
  // Prompt assembly must not fail the turn, so the cause stays in logs with a stable code.
  console.error(JSON.stringify({
    code,
    error: error instanceof Error ? error.message : String(error),
  }));
}

async function effectiveExternalCapabilities(
  auth: SessionAuth,
  loadCapabilities: CapabilityLoader,
): Promise<EffectiveExternalCapabilities> {
  const policy = resolveExternalGroupToolPolicy(auth);
  if (!policy.restricted) return { capabilities: new Set(), includeApplicationCore: false };
  const identity = resolveExternalGroupPolicyIdentity(auth);
  if (!identity) return { capabilities: new Set(), includeApplicationCore: false };

  // An unavailable policy lookup must describe no capability at all, matching the fail-closed
  // execution boundary, instead of leaving the previous turn's wider guidance in place.
  let current: ReadonlySet<ExternalGroupToolName>;
  try {
    current = await loadCapabilities(identity);
  } catch (error) {
    logBlockFailure("AGENT_GROUP_CAPABILITY_LOOKUP_FAILED", error);
    return { capabilities: new Set(), includeApplicationCore: false };
  }
  return {
    capabilities: new Set([...policy.allowed].filter((capability) => current.has(capability))),
    includeApplicationCore: true,
  };
}

function verifiedTelegramChatId(auth: SessionAuth): string | null {
  const chatId = auth.current?.attributes.telegramChatId;
  return typeof chatId === "string" && chatId.length > 0 ? chatId : null;
}

export function createModeBlockResolver(dependencies: {
  loadCapabilities: CapabilityLoader;
  loadReactionPolicy: ReactionPolicyLoader;
  loadSkills: SkillLoader;
}) {
  return async function resolve(ctx: TurnBlockContext): Promise<string> {
    let environment: ReturnType<typeof resolveConversationEnvironment>;
    try {
      environment = resolveConversationEnvironment(ctx.session.auth);
    } catch (error) {
      logBlockFailure("AGENT_CONVERSATION_ENVIRONMENT_INVALID", error);
      return MODE_UNAVAILABLE_BLOCK;
    }
    const scheduledRun = isScheduledSession(ctx);
    // A scheduled run has no inbound message to react to, and a channel-authored turn keeps its
    // text-only surface, so neither one requests a reaction policy.
    const reactionsPossible = !scheduledRun && !isTelegramChannelSession(ctx.session.auth);
    let reactions: readonly string[] | null = null;
    const telegramChatId = reactionsPossible ? verifiedTelegramChatId(ctx.session.auth) : null;
    if (telegramChatId !== null) {
      try {
        reactions = resolveChatReactions(await dependencies.loadReactionPolicy(telegramChatId));
      } catch (error) {
        logBlockFailure("AGENT_TELEGRAM_REACTION_POLICY_LOOKUP_FAILED", error);
      }
    }
    if (environment !== "external") {
      return modeInstructions({ environment, reactions, scheduledRun });
    }

    // Channel-authored turns can receive text only. Keep prompt instructions aligned with the
    // descriptor-absent execution surface without consulting grants owned by human participants.
    if (isTelegramChannelSession(ctx.session.auth)) {
      return modeInstructions({
        capabilities: new Set(),
        channelAuthored: true,
        environment: "external",
        includeApplicationCore: false,
        reactions,
        scheduledRun,
        skills: new Set(),
      });
    }

    const effective = await effectiveExternalCapabilities(
      ctx.session.auth,
      dependencies.loadCapabilities,
    );
    let skills: ReadonlySet<GroupSafeSkillName> = new Set();
    const groupId = ctx.session.auth.current?.attributes.groupId;
    if (typeof groupId === "string") {
      try {
        skills = await dependencies.loadSkills(groupId);
      } catch (error) {
        logBlockFailure("AGENT_GROUP_SKILL_LOOKUP_FAILED", error);
      }
    }
    return modeInstructions({
      capabilities: effective.capabilities,
      environment: "external",
      includeApplicationCore: effective.includeApplicationCore,
      reactions,
      scheduledHistory: effective.includeApplicationCore &&
        scheduledGroupHistoryAccess(ctx.session.auth) !== null,
      scheduledRun,
      skills,
    });
  };
}

export function createReactionSetBlockResolver(dependencies: {
  loadReactionPolicy: ReactionPolicyLoader;
}) {
  return async function resolve(ctx: TurnBlockContext): Promise<string | null> {
    // A scheduled run has no message to react to, and a channel-authored turn stays text-only.
    if (isScheduledSession(ctx) || isTelegramChannelSession(ctx.session.auth)) return null;
    const telegramChatId = verifiedTelegramChatId(ctx.session.auth);
    if (telegramChatId === null) return null;

    let policy: TelegramReactionPolicy | null = null;
    try {
      policy = await dependencies.loadReactionPolicy(telegramChatId);
    } catch (error) {
      logBlockFailure("AGENT_TELEGRAM_REACTION_POLICY_LOOKUP_FAILED", error);
      return null;
    }
    const reactions = resolveChatReactions(policy);
    if (reactions === null) return null;

    // Absence is the only trigger: a changed set renders a different message, and compaction that
    // replaced the old announcement also removes it.
    const announcement = formatReactionSetAnnouncement(reactions);
    return announcesReactionSet(ctx.messages, announcement) ? null : announcement;
  };
}

interface MemoryExposureLedger {
  authorCardShownRecently(applicationSessionId: string, telegramUserId: string, sessionTurn: number): Promise<boolean>;
  recentlyShownMemoryRefs(applicationSessionId: string, sessionTurn: number): Promise<Set<string>>;
  record(input: {
    applicationSessionId: string;
    authorTelegramUserId: string | null;
    memoryRefs: readonly string[];
    sessionTurn: number;
  }): Promise<void>;
  sessionTurn(applicationSessionId: string): Promise<number>;
}

export function createMemoryBlockResolver(dependencies: {
  authorize: (ctx: TurnBlockContext) => MemoryAuthorization;
  createProfile: (auth: MemoryAuthorization, input: CreateProfileViewInput) => Promise<ProfileView>;
  /** What this application session already showed; absent in tests that do not care about repetition. */
  exposures?: MemoryExposureLedger;
  retrieve: (
    auth: MemoryAuthorization,
    query: string,
    skillHints: readonly string[],
    options?: MemoryTurnContextOptions,
  ) => Promise<MemoryTurnContext>;
}) {
  return async function resolve(ctx: TurnBlockContext, turnId: string): Promise<string | null> {
    const started = performance.now();
    let outcome = "skipped";
    let memories: number | null = null;
    try {
      const authorization = dependencies.authorize(ctx);
      const query = memoryRetrievalQuery(ctx.session.auth, ctx.messages,
        ctx.channel?.kind === "subagent" || Boolean(ctx.session.parent));
      if (query === null) return null;
      // Records shown in the last turns of this application session stay out of the automatic
      // block and the current author's card returns only after a while: without this, three group
      // records circled through every turn, fifty times a day.
      const applicationSessionId = ctx.session.auth.current?.attributes.applicationSessionId;
      const exposures = typeof applicationSessionId === "string" ? dependencies.exposures : undefined;
      const sessionTurn = exposures ? await exposures.sessionTurn(applicationSessionId as string) : 0;
      const excludeMemoryRefs = exposures
        ? await exposures.recentlyShownMemoryRefs(applicationSessionId as string, sessionTurn)
        : new Set<string>();
      const context = await dependencies.retrieve(
        authorization,
        query,
        applicationThreadSkillHints(ctx.messages),
        { excludeMemoryRefs },
      );
      memories = context.memories.length;
      outcome = "succeeded";
      const profileInput = telegramProfileInput(ctx, context.retrievedClaimIds, turnId);
      const authorIsSubject = profileInput !== null && (
        profileInput.replyTelegramUserId === profileInput.currentTelegramUserId ||
        profileInput.explicitMentionTelegramUserIds.includes(profileInput.currentTelegramUserId));
      const suppressCurrentAuthor = profileInput !== null && exposures !== undefined && !authorIsSubject &&
        await exposures.authorCardShownRecently(applicationSessionId as string, profileInput.currentTelegramUserId, sessionTurn);
      const profile = profileInput === null
        ? null
        : await dependencies.createProfile(authorization, { ...profileInput, suppressCurrentAuthor });
      const shownMemoryRefs = [
        ...context.memories.flatMap((memory) => "memoryRef" in memory && typeof memory.memoryRef === "string" ? [memory.memoryRef] : []),
        ...(profile?.subjects.flatMap((subject) => subject.claims.map((claim) => claim.memoryRef)) ?? []),
      ];
      if (exposures) {
        const shownAuthorCard = profile?.subjects.some((subject) => subject.priority === "current_author") === true;
        await exposures.record({
          applicationSessionId: applicationSessionId as string,
          authorTelegramUserId: shownAuthorCard && profileInput !== null ? profileInput.currentTelegramUserId : null,
          memoryRefs: shownMemoryRefs,
          sessionTurn,
        });
      }
      return [
        ...(profile === null ? [] : [formatProfileViewContext(profile)]),
        // The reminder sits right after the records: the rule in the mode block alone was ignored.
        shownMemoryRefs.length === 0
          ? formatRetrievedMemoryInstructions(context.memories, context.threads)
          : `${formatRetrievedMemoryInstructions(context.memories, context.threads)}\n${MEMORY_USED_REMINDER}`,
      ].join("\n\n");
    } catch (error) {
      outcome = "failed";
      logBlockFailure("AGENT_MEMORY_UNAVAILABLE", error);
      return MEMORY_UNAVAILABLE_BLOCK;
    } finally {
      console.info(JSON.stringify({ code: "AGENT_MEMORY_RETRIEVAL_METRICS", sessionId: ctx.session.id,
        turnId, outcome, memories, durationMs: Math.round(performance.now() - started) }));
    }
  };
}

function telegramProfileInput(
  ctx: TurnBlockContext,
  retrievalClaimIds: readonly string[],
  turnId: string,
): CreateProfileViewInput | null {
  if (isTelegramChannelSession(ctx.session.auth)) return null;
  const attributes = ctx.session.auth.current?.attributes;
  const conversationId = attributes?.telegramConversationId;
  if (typeof conversationId !== "string") return null;
  if (!attributes) return null;
  const currentTelegramUserId = attributes.telegramUserId;
  const turnStartedAt = attributes.telegramTurnStartedAt;
  const mentions = attributes.telegramProfileMentionUserIds;
  if (typeof currentTelegramUserId !== "string" || typeof turnStartedAt !== "string" ||
    (mentions !== undefined && !Array.isArray(mentions))) {
    throw new Error(
      "AGENT_PROFILE_TURN_CONTEXT_INVALID: Не удалось проверить данные текущего Telegram-профиля",
    );
  }
  const now = new Date(turnStartedAt);
  if (Number.isNaN(now.getTime())) {
    throw new Error("AGENT_PROFILE_TURN_CONTEXT_INVALID: Некорректно время текущего Telegram-хода");
  }
  const replyTelegramUserId = attributes.telegramProfileReplyUserId;
  const replyTimelineSequence = attributes.telegramProfileReplyTimelineSequence;
  if ((replyTelegramUserId !== undefined && typeof replyTelegramUserId !== "string") ||
    (replyTimelineSequence !== undefined && typeof replyTimelineSequence !== "string")) {
    throw new Error(
      "AGENT_PROFILE_TURN_CONTEXT_INVALID: Некорректен проверенный сигнал Telegram-профиля",
    );
  }
  return {
    conversationId,
    currentTelegramUserId,
    explicitMentionTelegramUserIds: mentions === undefined ? [] : [...mentions],
    now,
    provenance: { sessionId: ctx.session.id, turnId },
    replyTelegramUserId: replyTelegramUserId ?? null,
    ...(replyTimelineSequence === undefined ? {} : { replyTimelineSequence }),
    retrievalClaimIds: [...retrievalClaimIds],
  };
}

export function createPreferenceBlockResolver(dependencies: {
  authorize: (ctx: TurnBlockContext) => BehaviorPreferenceReadAuthorization;
  get: (auth: BehaviorPreferenceReadAuthorization) => Promise<ChatOperationalPrompt>;
}) {
  return async function resolve(ctx: TurnBlockContext): Promise<string | null> {
    try {
      const authorization = dependencies.authorize(ctx);
      return buildBehaviorPreferenceInstructions(await dependencies.get(authorization));
    } catch (error) {
      // The editable prompt only shapes presentation, so an absent block is safe on failure.
      logBlockFailure("AGENT_BEHAVIOR_PREFERENCE_UNAVAILABLE", error);
      return null;
    }
  };
}

const reactionPolicyLoader: ReactionPolicyLoader = async (telegramChatId) => {
  const cached = await telegramReactionPolicyRepository.read(telegramChatId);
  if (cached === null) return null;
  // Past the refresh window the record proves only that getChat keeps failing, so the prompt
  // must not describe a reaction set an administrator may have already changed.
  const age = Date.now() - cached.fetchedAt.getTime();
  if (age >= TELEGRAM_REACTION_POLICY_TTL_MILLISECONDS) return null;
  return { allowsAll: cached.allowsAll, emoji: cached.emoji };
};

export const resolveModeBlock = createModeBlockResolver({
  loadCapabilities: loadCurrentExternalGroupCapabilities,
  loadReactionPolicy: reactionPolicyLoader,
  loadSkills: (groupId) => groupSkillPolicyRepository.loadGroupSkillAllowlist(groupId),
});

export const resolveReactionSetBlock = createReactionSetBlockResolver({
  loadReactionPolicy: reactionPolicyLoader,
});

export const resolveMemoryBlock = createMemoryBlockResolver({
  authorize: requireMemoryAuthorization,
  createProfile: profileViewRepository.create,
  exposures: memoryContextExposureRepository,
  retrieve: retrieveMemoryTurnContext,
});

export const resolvePreferenceBlock = createPreferenceBlockResolver({
  authorize: requireBehaviorPreferenceReadAuthorization,
  get: behaviorPreferenceRepository.get,
});
