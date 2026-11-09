/**
 * Mode-scoped executable tool surface.
 *
 * Exports:
 * - `ModeToolSurfaceInput`: verified facts a tool surface may be built from.
 * - `TRUSTED_MODE_TOOL_NAMES`, `PRIVATE_ONLY_TOOL_NAMES`, `OWNER_ONLY_TOOL_NAMES`, `FAMILY_ONLY_TOOL_NAMES`: the matrix.
 * - `buildModeToolSurface`: the exact root-agent tool map for one verified turn.
 * - `buildSubagentToolSurface`: the same trust zone, cut to the explicit list of subagent tools; a tool
 *   a child may only read from comes with its reading actions alone.
 *
 * Key constructs:
 * - Every tool is emitted per mode, the runtime's built-ins included, so a tool that cannot work in
 *   the current trust zone has no descriptor at all. Trusted modes get the runtime's built-ins
 *   (agent, bash, read_file, write_file, todo, load_skill); the owner's administration exists only in the
 *   owner's own private chat, never in another member's; an external group
 *   gets only its own file tools, `load_skill`, its granted capabilities and, without a verified
 *   registration, nothing beyond that.
 * - External groups re-check every granted capability at execution time against the live policy. A
 *   right to list or read memory gives an action of a memory tool, not a tool of its own (#457).
 * - Interactive private and family surfaces wrap the sandbox built-ins (plus glob and grep), so
 *   that every tool result there can carry the messages the turn's author sent meanwhile.
 *   Scheduled surfaces do not.
 */
import { defineTool, type ToolDefinition } from "../../runtime/tool.js";
import { bash, loadSkill, readFile, todo, writeFile } from "../../runtime/tools/defaults.js";
import { agentTool } from "../../runtime/tools/delegate.js";
import { z } from "zod";

import { GIF_REPLIES_AVAILABLE } from "../gifs/gif-reply-availability.js";
import { MODEL_VISION_AVAILABLE } from "../model-vision-availability.js";
import { gateDisconnectedGroup, wrapModelFacingTool, wrapModelFacingToolMap } from "../model-facing-tool.js";
import { externalGroupLoadSkillTool } from "../group-skills/group-load-skill-tool.js";
import { externalRememberInputSchema } from "../remember-contract.js";
import getCurrentTime from "../tools/get_current_time.js";
import { conversationWebFetch, conversationWebSearch } from "./conversation-web-tools.js";
import { externalGroupBash } from "./external-group-bash.js";
import importTelegramAttachment from "../tools/import_telegram_attachment.js";
import inspectWorkspaceImage from "../tools/inspect_workspace_image.js";
import listGroupHistory from "../tools/list_group_history.js";
import manageBehaviorPreference from "../tools/manage_behavior_preference.js";
import { manageMemoryPresentation } from "../tools/manage_memory.js";
import { manageMemoryThreadPresentation, MEMORY_THREAD_READING_ACTIONS } from "../tools/manage_memory_thread.js";
import remember from "../tools/remember.js";
import readScheduledGroupHistory from "../tools/read_scheduled_group_history.js";
import readProfileView from "../tools/read_profile_view.js";
import searchMemories from "../tools/search_memories.js";
import sendGif from "../tools/send_gif.js";
import sendContact from "../tools/send_contact.js";
import sendLocation from "../tools/send_location.js";
import sendPoll from "../tools/send_poll.js";
import sendVoiceMessage from "../tools/send_voice_message.js";
import { removeGroupFileTool } from "../workspaces/remove-group-file-tool.js";
import { AGENT_SCHEDULE_LIST_VIEW } from "../agent-schedules/agent-schedule-list-action.js";
import { createOwnerSettingsTool, OWNER_SETTINGS_SCHEDULED_SECTIONS } from "../tools/owner_settings.js";
import { actionView, type ActionPresentation } from "./action-view.js";
import { controlledWebFetchTool } from "./controlled-web-fetch.js";
import { EXTERNAL_GROUP_FILE_TOOLS } from "./external-group-file-tools.js";
import { authorizeExternalGroupRight, externalMemoryTools, FOLDED_MEMORY_RIGHTS } from "./external-group-memory-tools.js";
import { EXTERNAL_GROUP_REMINDER_TOOLS } from "./external-group-reminder-tools.js";
import { scheduledExternalTool, scheduledSendTool } from "./scheduled-external-tool.js";
import { SUBAGENT_TOOL_ACTIONS, SUBAGENT_TOOL_NAMES } from "./subagent-tool-names.js";
import { withTurnInterjectionSurface } from "../turn-interjection/turn-interjection-surface.js";
import { BASELINE_EXTERNAL_GROUP_GRANTS, isExternalGroupToolName, type ExternalGroupToolName } from "./group-tool-catalog.js";
import {
  FAMILY_ONLY_TOOLS,
  OWNER_ONLY_TOOLS,
  PRIVATE_ONLY_TOOLS,
  TRUSTED_MODE_TOOLS,
} from "./trusted-mode-tool-catalog.js";

export {
  FAMILY_ONLY_TOOL_NAMES,
  OWNER_ONLY_TOOL_NAMES,
  PRIVATE_ONLY_TOOL_NAMES,
  TRUSTED_MODE_TOOL_NAMES,
} from "./trusted-mode-tool-catalog.js";

type AnyToolDefinition = ToolDefinition<any, any>;
type ToolMap = Readonly<Record<string, AnyToolDefinition>>;

export type ModeToolSurfaceInput =
  | { environment: "family"; scheduledRun?: boolean }
  // `owner`: the verified caller is the family's owner, whose private chat also carries administration.
  | { environment: "private"; owner: boolean; scheduledRun?: boolean }
  | {
      capabilities: ReadonlySet<ExternalGroupToolName>;
      environment: "external";
      includeApplicationCore?: boolean;
      scheduledHistory?: boolean;
      scheduledRun?: boolean;
    };

// A file of the group goes inside the answer that shows it: its persisted grant has no tool. A right to
// list or read memory gives an action of a memory tool (`external-group-memory-tools.ts`).
type DirectExternalToolName = Exclude<
  ExternalGroupToolName,
  | `manage_memory.${string}`
  | `manage_memory_thread.${string}`
  | "list_memories"
  | "list_memory_threads"
  | "read_memory_thread"
  | "search_memory_threads"
  | "send_workspace_file"
  | "web_search"
>;

const EXTERNAL_IMAGE_PATH_MAX_LENGTH = 512;
const EXTERNAL_MODEL_TEXT_MAX_LENGTH = 4_000;

// Shared executors remain unchanged, while external descriptors expose only their executable group
// contract. This prevents the model from planning calls that external authorization must reject.
const EXTERNAL_DIRECT_TOOL_PRESENTATION: Readonly<
  Partial<Record<DirectExternalToolName, Pick<AnyToolDefinition, "description" | "inputSchema">>>
> = {
  inspect_workspace_image: {
    description: [
      "Analyze an image of the current external group from exactly one source: attachmentId, avatarOfSequence, telegramMessageId or path.",
      "For path pass a relative path inside the group scope, for example photos/image.png, not /workspace/group/photos/image.png.",
      "For a participant's current avatar pass avatarOfSequence, not telegramMessageId: the #N of any of their messages in this group, {\"avatarOfSequence\":\"53247\",\"scope\":\"group\",\"question\":\"Есть ли на аватарке человек? Если да, опиши внешность\"}; the avatar is fetched fresh every time and never saved.",
      "The result contains analysis, path and scope; the analysis does not save Telegram bytes. avatar=missing means the participant has no avatar or hides it from bots.",
    ].join(" "),
    inputSchema: z
      .object({
        attachmentId: z.uuid().optional(),
        avatarOfSequence: z.string().regex(/^\d{1,18}$/u)
          .describe("For a participant's current Telegram avatar: the #N timeline number of any of their messages, without #")
          .optional(),
        path: z.string().min(1).max(EXTERNAL_IMAGE_PATH_MAX_LENGTH).optional(),
        question: z.string().min(1).max(EXTERNAL_MODEL_TEXT_MAX_LENGTH),
        scope: z.literal("group").describe("The scope of the current external group"),
        telegramMessageId: z.string().regex(/^\d+$/u)
          .describe("The Telegram message_id of the current message whose own attached image to inspect; never a #N timeline number and never for an avatar")
          .optional(),
      })
      .strict(),
  },
  import_telegram_attachment: {
    description:
      "Download one file of any format from a message of the current external group into /workspace/group. The result gives its path and mediaType: read a text file through read_file, and work with any other format only through the tools of this turn.",
    inputSchema: z
      .object({
        attachmentId: z.uuid().describe("An opaque attachmentId from the current message or the group history"),
      })
      .strict(),
  },
  remember: {
    description:
      "Save one specific fact from the current message or from one verified sourceSequence of the visible delta into the current external group's memory: a fact, a preference, first-hand experience, an event, a plan or a useful link with context. Do not require special importance or a request to remember; do not save guesses.",
    inputSchema: externalRememberInputSchema,
  },
};

const EXTERNAL_DIRECT_TOOLS: Readonly<Record<DirectExternalToolName, AnyToolDefinition>> = {
  bash: externalGroupBash,
  import_telegram_attachment: importTelegramAttachment as unknown as AnyToolDefinition,
  inspect_workspace_image: inspectWorkspaceImage as unknown as AnyToolDefinition,
  list_group_history: listGroupHistory as unknown as AnyToolDefinition,
  remember: remember as unknown as AnyToolDefinition,
  remove_group_file: removeGroupFileTool as unknown as AnyToolDefinition,
  search_memories: searchMemories as unknown as AnyToolDefinition,
  send_voice_message: sendVoiceMessage as unknown as AnyToolDefinition,
  web_fetch: controlledWebFetchTool as unknown as AnyToolDefinition,
};

function allowedDirectTool(capability: DirectExternalToolName, definition: AnyToolDefinition): AnyToolDefinition {
  return defineTool({
    ...definition,
    ...EXTERNAL_DIRECT_TOOL_PRESENTATION[capability],
    async execute(input, ctx) {
      await authorizeExternalGroupRight(ctx, capability);
      return await definition.execute(input, ctx);
    },
  });
}

/**
 * A baseline tool in its group presentation. It needs no grant check: each one authorizes the group
 * scope and the referenced message live by itself.
 */
function externalContentTool(capability: "import_telegram_attachment" | "inspect_workspace_image"): AnyToolDefinition {
  return defineTool({ ...EXTERNAL_DIRECT_TOOLS[capability], ...EXTERNAL_DIRECT_TOOL_PRESENTATION[capability] });
}

function buildExternalToolSurface(
  allowed: ReadonlySet<ExternalGroupToolName>,
  includeApplicationCore: boolean,
  scheduledHistory: boolean,
  scheduledRun: boolean,
): ToolMap {
  // Loading a skill is always offered: which skills load is decided per call, against the group's
  // live list and the service skills of the turn (`group-load-skill-tool.ts`).
  const surface: Record<string, AnyToolDefinition> = {
    ...EXTERNAL_GROUP_FILE_TOOLS,
    load_skill: externalGroupLoadSkillTool,
  };
  if (includeApplicationCore) {
    surface.web_search = conversationWebSearch as AnyToolDefinition;
    surface.web_fetch = conversationWebFetch as AnyToolDefinition;
    surface.get_current_time = getCurrentTime as AnyToolDefinition;
    surface.todo = todo as AnyToolDefinition;
    surface.read_profile_view = readProfileView as unknown as AnyToolDefinition;
    // What participants send is visible in every group: no grant, only a model that sees images.
    surface.import_telegram_attachment = externalContentTool("import_telegram_attachment");
    if (MODEL_VISION_AVAILABLE) surface.inspect_workspace_image = externalContentTool("inspect_workspace_image");
    // A GIF, a place, a poll and a contact card need no grant, in a live turn and in a scenario alike:
    // the owner's rule of 09.11.2026 (F3 of #480) makes them available to everyone everywhere.
    if (GIF_REPLIES_AVAILABLE) surface.send_gif = sendGif as unknown as AnyToolDefinition;
    surface.send_contact = sendContact as unknown as AnyToolDefinition;
    surface.send_location = sendLocation as unknown as AnyToolDefinition;
    surface.send_poll = sendPoll as unknown as AnyToolDefinition;
    if (!scheduledRun) {
      surface.manage_behavior_preference = manageBehaviorPreference as unknown as AnyToolDefinition;
      // Reminders need no grant: the caps are enforced per Telegram author and per chat, and a
      // background run has no participant who could own a new one.
      Object.assign(surface, EXTERNAL_GROUP_REMINDER_TOOLS);
    }
    if (scheduledHistory) {
      surface.read_scheduled_group_history = readScheduledGroupHistory as unknown as AnyToolDefinition;
    }
  }
  // Granted application capabilities are re-checked at execution against the live policy.
  for (const capability of allowed) {
    // A grant that became baseline access gives no tool of its own: page reading is a baseline
    // tool, and a group file goes inside the answer that shows it.
    if (BASELINE_EXTERNAL_GROUP_GRANTS.has(capability)) continue;
    // A scheduled prompt has no current user message that can back a new memory claim.
    if (scheduledRun && capability === "remember") continue;
    if (FOLDED_MEMORY_RIGHTS.has(capability)) continue;
    if (!isExternalGroupToolName(capability)) continue;
    const definition = EXTERNAL_DIRECT_TOOLS[capability as DirectExternalToolName];
    if (definition === undefined) continue;
    surface[capability] = allowedDirectTool(capability as DirectExternalToolName, definition);
  }
  Object.assign(surface, externalMemoryTools(allowed));

  const effectiveSurface = scheduledRun
    ? Object.fromEntries(Object.entries(surface).map(([name, definition]) => [name, scheduledExternalTool(definition)]))
    : surface;
  // A verified external group delegates like any root turn (the built-in, never wrapped for errors, only
  // checked for a disconnected group, #465); a child never gets it, see `buildSubagentToolSurface`.
  const wrapped = wrapModelFacingToolMap(effectiveSurface);
  return includeApplicationCore ? { ...wrapped, agent: gateDisconnectedGroup(agentTool as AnyToolDefinition) } : wrapped;
}

function allowlistKey(allowed: ReadonlySet<ExternalGroupToolName>): string {
  return [...allowed].sort().join("\0");
}

// The runtime's built-ins of every trusted turn. They stay outside the model-facing error wrapper:
// their errors are already written for the model.
const TRUSTED_BUILT_IN_TOOLS: ToolMap = {
  agent: agentTool as AnyToolDefinition,
  bash: bash as AnyToolDefinition,
  load_skill: loadSkill as AnyToolDefinition,
  read_file: readFile as AnyToolDefinition,
  todo: todo as AnyToolDefinition,
  write_file: writeFile as AnyToolDefinition,
};

// `private` is a family member's own chat; `owner` is the owner's, the same plus the owner's
// administration, kept in name order so the owner's tool set reaches the model as before.
type TrustedSurfaceKey = "family" | "owner" | "private";

const TRUSTED_APPLICATION_SURFACES: Readonly<Record<TrustedSurfaceKey, ToolMap>> = {
  family: wrapModelFacingToolMap({
    ...TRUSTED_MODE_TOOLS,
    ...FAMILY_ONLY_TOOLS,
  }),
  owner: wrapModelFacingToolMap({
    ...TRUSTED_MODE_TOOLS,
    ...Object.fromEntries(Object.entries({ ...PRIVATE_ONLY_TOOLS, ...OWNER_ONLY_TOOLS })
      .sort(([left], [right]) => (left < right ? -1 : 1))),
  }),
  private: wrapModelFacingToolMap({
    ...TRUSTED_MODE_TOOLS,
    ...PRIVATE_ONLY_TOOLS,
  }),
};

// An interactive turn also receives, with each tool result, the messages its author sent meanwhile.
// The interjection surface brings its own sandbox built-ins; delegation, todo and skills stay as is.
const UNWRAPPED_BUILT_INS: ToolMap = {
  agent: TRUSTED_BUILT_IN_TOOLS.agent!,
  load_skill: TRUSTED_BUILT_IN_TOOLS.load_skill!,
  todo: TRUSTED_BUILT_IN_TOOLS.todo!,
};
const TRUSTED_SURFACES: Readonly<Record<TrustedSurfaceKey, ToolMap>> = {
  family: { ...UNWRAPPED_BUILT_INS, ...withTurnInterjectionSurface(TRUSTED_APPLICATION_SURFACES.family) },
  owner: { ...UNWRAPPED_BUILT_INS, ...withTurnInterjectionSurface(TRUSTED_APPLICATION_SURFACES.owner) },
  private: { ...UNWRAPPED_BUILT_INS, ...withTurnInterjectionSurface(TRUSTED_APPLICATION_SURFACES.private) },
};

// What a scenario sends goes out only while its run, author and chat are still authorized, as its
// final text does before delivery (#480).
const SCENARIO_SEND_TOOL_NAMES = ["send_contact", "send_gif", "send_location", "send_poll", "send_voice_message", "send_widget"] as const;
const RAW_TRUSTED_TOOLS: ToolMap = { ...TRUSTED_MODE_TOOLS, ...FAMILY_ONLY_TOOLS, ...PRIVATE_ONLY_TOOLS, ...OWNER_ONLY_TOOLS };

function authorizedScenarioSends(surface: ToolMap): ToolMap {
  return Object.fromEntries(SCENARIO_SEND_TOOL_NAMES.flatMap((name) => {
    const raw = RAW_TRUSTED_TOOLS[name];
    return surface[name] === undefined || raw === undefined ? [] : [[name, wrapModelFacingTool(name, scheduledSendTool(raw))]];
  }));
}

const TRUSTED_SCHEDULED_SURFACES: Readonly<Record<TrustedSurfaceKey, ToolMap>> = Object.fromEntries(
  Object.entries(TRUSTED_APPLICATION_SURFACES).map(([environment, surface]) => {
    // A scheduled turn can read chat instructions but has no user source for prompt or memory writes.
    // Family skills are managed only in a conversation with the owner, and nobody is there to confirm
    // network access or to send a requested API key: the owner's door keeps its other sections.
    // A scenario sends whatever a live turn of its chat sends (#480): a voice note, a widget, a GIF,
    // a place, a poll, a contact. Only changing a widget already shown stays with the live chat,
    // where its presses arrive.
    const {
      manage_behavior_preference: _manageBehaviorPreference,
      manage_skill: _manageSkill,
      owner_settings: ownerSettings,
      remember: _remember,
      update_widget: _updateWidget,
      ...readOnlyPromptSurface
    } = surface;
    return [environment, {
      ...TRUSTED_BUILT_IN_TOOLS,
      ...readOnlyPromptSurface,
      ...authorizedScenarioSends(readOnlyPromptSurface),
      ...(ownerSettings === undefined ? {} : {
        owner_settings: wrapModelFacingTool("owner_settings", createOwnerSettingsTool(OWNER_SETTINGS_SCHEDULED_SECTIONS)),
      }),
    }];
  }),
) as Record<TrustedSurfaceKey, ToolMap>;

function trustedSurfaceKey(input: Extract<ModeToolSurfaceInput, { environment: "family" | "private" }>): TrustedSurfaceKey {
  if (input.environment === "family") return "family";
  return input.owner ? "owner" : "private";
}

const EXTERNAL_SURFACES = new Map<string, ToolMap>();

export function buildModeToolSurface(input: ModeToolSurfaceInput): ToolMap {
  if (input.environment !== "external") {
    return input.scheduledRun === true
      ? TRUSTED_SCHEDULED_SURFACES[trustedSurfaceKey(input)]
      : TRUSTED_SURFACES[trustedSurfaceKey(input)];
  }

  // A malformed allowlist value means the trusted snapshot is corrupt, so deny every capability.
  const allowed = [...input.capabilities].some((name) => !isExternalGroupToolName(name))
    ? new Set<ExternalGroupToolName>()
    : input.capabilities;
  const includeApplicationCore = input.includeApplicationCore !== false;
  const scheduledHistory = input.scheduledHistory === true;
  const scheduledRun = input.scheduledRun === true || scheduledHistory;
  const key = [
    includeApplicationCore ? "core" : "failed",
    scheduledHistory ? "history" : "ordinary",
    scheduledRun ? "scheduled" : "interactive",
    allowlistKey(allowed),
  ].join("|");
  const cached = EXTERNAL_SURFACES.get(key);
  if (cached) return cached;
  const surface = buildExternalToolSurface(allowed, includeApplicationCore, scheduledHistory, scheduledRun);
  EXTERNAL_SURFACES.set(key, surface);
  return surface;
}

// What a child may only read from it sees with its reading actions alone (`SUBAGENT_TOOL_ACTIONS`).
const SUBAGENT_VIEW_PRESENTATIONS: Readonly<Record<string, ActionPresentation>> = {
  manage_agent_schedule: AGENT_SCHEDULE_LIST_VIEW,
  manage_memory: manageMemoryPresentation(["list"]),
  manage_memory_thread: manageMemoryThreadPresentation(MEMORY_THREAD_READING_ACTIONS),
};

function trustedSubagentViews(base: ToolMap): ToolMap {
  return Object.fromEntries(Object.entries(SUBAGENT_TOOL_ACTIONS).flatMap(([name, actions]) => {
    const definition = base[name];
    const presentation = SUBAGENT_VIEW_PRESENTATIONS[name];
    if (definition === undefined) return [];
    if (presentation === undefined) throw new Error(`SUBAGENT_VIEW_PRESENTATION_MISSING: ${name}`);
    // Built over the unwrapped tool, so the model-facing boundary records each call once.
    return [[name, wrapModelFacingTool(name, actionView({ actions, definition, presentation, toolName: name }))]];
  }));
}

const TRUSTED_SUBAGENT_VIEWS: Readonly<Record<"family" | "private", ToolMap>> = {
  family: trustedSubagentViews({ ...TRUSTED_MODE_TOOLS, ...FAMILY_ONLY_TOOLS }),
  private: trustedSubagentViews({ ...TRUSTED_MODE_TOOLS, ...PRIVATE_ONLY_TOOLS }),
};

// A child never sends a voice note in place of the reply of the agent that called it, and never
// changes memory: an external group's surface built without these rights offers it reading alone.
function childRight(name: ExternalGroupToolName): boolean {
  return name !== "send_voice_message" && !name.startsWith("manage_memory.") && !name.startsWith("manage_memory_thread.");
}

export function buildSubagentToolSurface(input: ModeToolSurfaceInput): ToolMap {
  // Delegation is one level deep, so `agent` is not on the list; neither is anything a delegated
  // task (often reading untrusted pages) should not do on its own, see `SUBAGENT_TOOL_NAMES`.
  if (input.environment === "external") {
    const surface = buildModeToolSurface({ ...input, capabilities: new Set([...input.capabilities].filter(childRight)) });
    return Object.fromEntries(Object.entries(surface)
      .filter(([name]) => SUBAGENT_TOOL_NAMES.has(name) || Object.hasOwn(SUBAGENT_TOOL_ACTIONS, name)));
  }
  return {
    ...Object.fromEntries(Object.entries(buildModeToolSurface(input)).filter(([name]) => SUBAGENT_TOOL_NAMES.has(name))),
    ...TRUSTED_SUBAGENT_VIEWS[input.environment],
  };
}
