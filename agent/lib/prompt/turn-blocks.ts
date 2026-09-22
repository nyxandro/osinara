/**
 * Turn-scoped prompt block resolution.
 *
 * Exports:
 * - `TurnBlockContext`: the minimal Eve resolve context a block resolver reads.
 * - `createModeBlockResolver` / `resolveModeBlock`: verified mode rulebook for the current turn.
 * - `createReactionSetBlockResolver` / `resolveReactionSetBlock`: reaction set announced in history.
 * - `createMemoryBlockResolver` / `resolveMemoryBlock`: authorized long-term memory records,
 *   wrapped in the payload markers; a memory service notice is returned unwrapped.
 * - `createPreferenceBlockResolver` / `resolvePreferenceBlock`: one editable chat prompt.
 *
 * Key constructs:
 * - Eve 0.40 clears turn-scoped system selections on each new turn. Explicit unavailable blocks
 *   explain known failures to the model; `null` is used only when no context is needed.
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
  memoryRetrievalQuery,
  recordOfferedMemories,
  retrieveMemoryTurnContext,
  type MemoryRetrievalDiagnostics,
  type MemoryTurnContext,
  type ModelMemoryContextItem,
} from "../memory-retrieval.js";
import { memoryShowJournal, type MemorySelectionWindow } from "../memory-show-journal.js";
import {
  MemoryContextFailure, memoryFailureCode, recordMemoryContextIncident,
  type MemoryContextIncident, type MemoryContextPhase,
} from "../memory-context-failure.js";
import { memorySelectionMetrics } from "../memory-observability.js";
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
import { applyTurnMemoryBudget } from "./turn-memory-budget.js";
import { formatTurnMemoryContext } from "./turn-memory-context.js";

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
  "Продолжай исходную задачу в частях, не зависящих от памяти. Этот служебный блок не является новым запросом.",
  "Для частей, требующих памяти, сообщи конкретное ограничение: нужные сведения сейчас проверить нельзя. Не придумывай их и не объявляй задачу полностью выполненной.",
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
    // A child answers its parent through the `agent` tool result, never the chat itself.
    const subagentTurn = ctx.channel?.kind === "subagent" || Boolean(ctx.session.parent);
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
      return modeInstructions({ environment, reactions, scheduledRun, subagentTurn });
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
        subagentTurn,
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
      subagentTurn,
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

export function createMemoryBlockResolver(dependencies: {
  reportFailure: (incident: MemoryContextIncident) => Promise<void>;
  authorize: (ctx: TurnBlockContext) => MemoryAuthorization;
  createProfile: (auth: MemoryAuthorization, input: CreateProfileViewInput) => Promise<ProfileView>;
  openSelectionWindow: (conversationId: string, eveSessionId: string, turnId: string) => Promise<number>;
  recordOffered: (
    window: MemorySelectionWindow | null,
    context: MemoryTurnContext,
    offered: readonly ModelMemoryContextItem[],
    shownElsewhereRefs: readonly string[],
  ) => Promise<void>;
  retrieve: (
    auth: MemoryAuthorization,
    query: string,
    skillHints: readonly string[],
    window: MemorySelectionWindow | null,
  ) => Promise<MemoryTurnContext>;
}) {
  return async function resolve(ctx: TurnBlockContext, turnId: string): Promise<string | null> {
    const started = performance.now();
    let outcome = "skipped";
    let memories: number | null = null;
    let diagnostics: MemoryRetrievalDiagnostics | null = null;
    let selection = memorySelectionMetrics(null);
    let profileCharacters: number | null = null;
    let droppedMemories: number | null = null;
    let offeredMemories: number | null = null;
    let profileMemoryRefs: string[] | null = null;
    let threadRefs: string[] | null = null;
    let threadCharacters: number | null = null;
    let phase: MemoryContextPhase = "authorization";
    let causeCode: string | null = null;
    try {
      const authorization = dependencies.authorize(ctx);
      phase = "query";
      const delegated = ctx.channel?.kind === "subagent" || Boolean(ctx.session.parent);
      const query = memoryRetrievalQuery(ctx.session.auth, ctx.messages, delegated);
      if (query === null) return null;
      phase = "retrieval";
      // The window exists only where there is a conversation to remember inside; a scheduled run
      // has none, and then the selection behaves as it always did. A turn is identified by the Eve
      // session together with its id: Eve numbers turns inside a session and replaces the session
      // every fifty of them, so `turn_0` comes round again inside one long conversation.
      //
      // A delegated child inherits the parent's verified auth, conversation included, but it is
      // not a turn of the conversation: it runs inside one. Giving it a window would let its work
      // hide records from the person's next question and would spend turn numbers nobody spoke in.
      const conversationId = delegated
        ? undefined
        : ctx.session.auth.current?.attributes.telegramConversationId;
      const window = typeof conversationId === "string"
        ? {
          conversationId,
          eveSessionId: ctx.session.id,
          turnId,
          turnOrdinal: await dependencies.openSelectionWindow(
            conversationId, ctx.session.id, turnId,
          ),
        }
        : null;
      const context = await dependencies.retrieve(
        authorization,
        query,
        applicationThreadSkillHints(ctx.messages),
        window,
      );
      memories = context.memories.length;
      diagnostics = context.diagnostics;
      outcome = "succeeded";
      phase = "profile";
      const profileInput = telegramProfileInput(ctx, context.retrievedClaimIds, turnId);
      const profile = profileInput === null
        ? null
        : await dependencies.createProfile(authorization, profileInput);
      profileCharacters = profile === null ? 0 : JSON.stringify(profile.subjects).length;
      profileMemoryRefs = profile === null ? []
        : profile.subjects.flatMap((subject) => subject.claims.map((claim) => claim.memoryRef));
      threadRefs = context.threads.threads.map((thread) => thread.threadRef);
      threadCharacters = JSON.stringify(context.threads).length;
      // The block is the one part of the request the model recomputes every message, so its total
      // size is bounded here. The budget measures what the model will actually receive: each
      // candidate goes through the same formatter, wrapper and escaping included.
      //
      // Only retrieved data carries the payload markers. The unavailable notice below is a rule
      // about behaviour, so it stays unwrapped and keeps its place in the instruction prefix.
      const renderBlock = (memories: readonly ModelMemoryContextItem[]) => formatTurnMemoryContext([
        ...(profile === null ? [] : [formatProfileViewContext(profile)]),
        formatRetrievedMemoryInstructions(
          memories, context.threads, context.diagnostics.semanticBranchAvailable,
        ),
      ].join("\n\n"));
      const budget = applyTurnMemoryBudget({ memories: context.memories, render: renderBlock });
      droppedMemories = budget.droppedMemories;
      offeredMemories = budget.memories.length;
      selection = memorySelectionMetrics(budget.memories);
      // The journal hears about the selection only now: a record the budget dropped was never put
      // in front of the model, and writing it down would hide it from the next turns.
      phase = "journal";
      await dependencies.recordOffered(window, context, budget.memories, profileMemoryRefs);
      phase = "format";
      const block = renderBlock(budget.memories);
      if (budget.overBudget) {
        // Not trimming any more: the profile and threads filled the ceiling by themselves, so the
        // block ships over budget with the best match kept. Their own limits count rendered text
        // while this one counts the assembled block, which is how they can outgrow it.
        console.warn(JSON.stringify({
          code: "AGENT_MEMORY_TURN_BLOCK_OVER_BUDGET", blockCharacters: block.length,
          droppedMemories, offeredMemories, profileCharacters, threadCharacters,
          sessionId: ctx.session.id, turnId,
        }));
      }
      return block;
    } catch (error) {
      outcome = "failed";
      if (error instanceof MemoryContextFailure) phase = error.phase;
      causeCode = memoryFailureCode(error);
      const attributes = ctx.session.auth.current?.attributes;
      const incident: MemoryContextIncident = {
        causeCode, phase, sessionId: ctx.session.id, turnId,
        runId: typeof attributes?.scheduledRunId === "string" ? attributes.scheduledRunId : null,
        scheduleId: typeof attributes?.scheduleId === "string" ? attributes.scheduleId : null,
      };
      console.error(JSON.stringify({ code: "AGENT_MEMORY_UNAVAILABLE", ...incident,
        errorName: error instanceof Error ? error.name : "UnknownError" }));
      try {
        await dependencies.reportFailure(incident);
      } catch (recordError) {
        // A failed incident store must not turn a known memory outage into loss of the user task.
        console.error(JSON.stringify({ code: "AGENT_MEMORY_INCIDENT_RECORD_FAILED",
          sessionId: ctx.session.id, turnId, causeCode: memoryFailureCode(recordError) }));
      }
      return MEMORY_UNAVAILABLE_BLOCK;
    } finally {
      console.info(JSON.stringify({ code: "AGENT_MEMORY_RETRIEVAL_METRICS", sessionId: ctx.session.id,
        turnId, outcome, memories, offeredMemories, droppedMemories, ...selection, ...diagnostics,
        profileCharacters, profileMemoryRefs,
        threadRefs, threadCharacters, failurePhase: outcome === "failed" ? phase : null, causeCode,
        durationMs: Math.round(performance.now() - started) }));
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
  reportFailure: recordMemoryContextIncident,
  authorize: requireMemoryAuthorization,
  createProfile: profileViewRepository.create,
  openSelectionWindow: memoryShowJournal.openTurn,
  recordOffered: recordOfferedMemories,
  retrieve: retrieveMemoryTurnContext,
});

export const resolvePreferenceBlock = createPreferenceBlockResolver({
  authorize: requireBehaviorPreferenceReadAuthorization,
  get: behaviorPreferenceRepository.get,
});
