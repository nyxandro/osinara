/**
 * Trusted private and family tool catalogs.
 *
 * Exports:
 * - `TRUSTED_MODE_TOOLS`: shared private/family tool definitions.
 * - `PRIVATE_ONLY_TOOLS`, `FAMILY_ONLY_TOOLS`: trust-zone-specific definitions.
 * - `OWNER_ONLY_TOOLS`: the owner's administration, offered only in the owner's own private chat, as one
 *   door (`owner_settings`, #459) to six sections instead of six tools on every turn.
 * - Sorted tool-name arrays used by policy contracts.
 *
 * A list of reminders, schedules, invitations, memory records or threads is an action of the tool
 * that changes them (#457), not a tool of its own.
 */
import type { ToolDefinition } from "../../runtime/tool.js";

import executeGoogleWorkspace from "../tools/execute_google_workspace.js";
import exportMemory from "../tools/export_memory.js";
import getCurrentTime from "../tools/get_current_time.js";
import getMemorySource from "../tools/get_memory_source.js";
import importTelegramAttachment from "../tools/import_telegram_attachment.js";
import inspectWorkspaceImage from "../tools/inspect_workspace_image.js";
import listGroupHistory from "../tools/list_group_history.js";
import listProactiveDeliveries from "../tools/list_proactive_deliveries.js";
import listTelegramAttachments from "../tools/list_telegram_attachments.js";
import manageAgentSchedule from "../tools/manage_agent_schedule.js";
import manageBehaviorPreference from "../tools/manage_behavior_preference.js";
import manageGoogleWorkspaceConnection from "../tools/manage_google_workspace_connection.js";
import manageGmailMessage from "../tools/manage_gmail_message.js";
import manageMemory from "../tools/manage_memory.js";
import manageMemoryThread from "../tools/manage_memory_thread.js";
import manageReminder from "../tools/manage_reminder.js";
import manageSkill from "../tools/manage_skill.js";
import notificationSettings from "../tools/notification_settings.js";
import { createOwnerSettingsTool, OWNER_SETTINGS_SECTIONS } from "../tools/owner_settings.js";
import readProfileView from "../tools/read_profile_view.js";
import remember from "../tools/remember.js";
import searchMemories from "../tools/search_memories.js";
import sendGif from "../tools/send_gif.js";
import sendContact from "../tools/send_contact.js";
import sendLocation from "../tools/send_location.js";
import sendWidget from "../tools/send_widget.js";
import updateWidget from "../tools/update_widget.js";
import { TELEGRAM_WIDGETS_AVAILABLE } from "../widgets/widget-config.js";
import sendPoll from "../tools/send_poll.js";
import sendVoiceMessage from "../tools/send_voice_message.js";
import startNewContext from "../tools/start_new_context.js";
import { GIF_REPLIES_AVAILABLE } from "../gifs/gif-reply-availability.js";
import { MODEL_VISION_AVAILABLE } from "../model-vision-availability.js";
import { conversationWebFetch, conversationWebSearch } from "./conversation-web-tools.js";

type AnyToolDefinition = ToolDefinition<any, any>;
type ToolMap = Readonly<Record<string, AnyToolDefinition>>;

/** Tools whose authorization boundary accepts both a private chat and a closed family group. */
export const TRUSTED_MODE_TOOLS: ToolMap = {
  web_fetch: conversationWebFetch as AnyToolDefinition,
  web_search: conversationWebSearch as AnyToolDefinition,
  execute_google_workspace: executeGoogleWorkspace as unknown as AnyToolDefinition,
  get_current_time: getCurrentTime as unknown as AnyToolDefinition,
  // Without image input every call would fail, so the descriptor is not offered at all.
  ...(MODEL_VISION_AVAILABLE
    ? { inspect_workspace_image: inspectWorkspaceImage as unknown as AnyToolDefinition }
    : {}),
  list_proactive_deliveries: listProactiveDeliveries as unknown as AnyToolDefinition,
  manage_agent_schedule: manageAgentSchedule as unknown as AnyToolDefinition,
  manage_behavior_preference: manageBehaviorPreference as unknown as AnyToolDefinition,
  manage_google_workspace_connection: manageGoogleWorkspaceConnection as unknown as AnyToolDefinition,
  manage_gmail_message: manageGmailMessage as unknown as AnyToolDefinition,
  manage_memory: manageMemory as unknown as AnyToolDefinition,
  manage_memory_thread: manageMemoryThread as unknown as AnyToolDefinition,
  manage_reminder: manageReminder as unknown as AnyToolDefinition,
  read_profile_view: readProfileView as unknown as AnyToolDefinition,
  remember: remember as unknown as AnyToolDefinition,
  search_memories: searchMemories as unknown as AnyToolDefinition,
  // Choosing a GIF needs image input and a KLIPY key; without them the tool is not offered at all.
  ...(GIF_REPLIES_AVAILABLE ? { send_gif: sendGif as unknown as AnyToolDefinition } : {}),
  send_contact: sendContact as unknown as AnyToolDefinition,
  send_location: sendLocation as unknown as AnyToolDefinition,
  send_poll: sendPoll as unknown as AnyToolDefinition,
  send_voice_message: sendVoiceMessage as unknown as AnyToolDefinition,
  start_new_context: startNewContext as unknown as AnyToolDefinition,
};

/** Personal-only surfaces of any family member's own private chat. */
export const PRIVATE_ONLY_TOOLS: ToolMap = {
  export_memory: exportMemory as unknown as AnyToolDefinition,
  get_memory_source: getMemorySource as unknown as AnyToolDefinition,
  manage_skill: manageSkill as unknown as AnyToolDefinition,
  notification_settings: notificationSettings as unknown as AnyToolDefinition,
  // Widgets work only in the private chat with the bot for now (owner's decision of 06.11.2026, #468).
  ...(TELEGRAM_WIDGETS_AVAILABLE
    ? { send_widget: sendWidget as unknown as AnyToolDefinition, update_widget: updateWidget as unknown as AnyToolDefinition }
    : {}),
};

/**
 * The owner's administration: each section refuses anyone but the owner in the owner's private chat at
 * execution, so another member's chat does not carry it at all (#458). The owner's chat carries one
 * door to the sections, not the six tools (#459).
 */
export const OWNER_ONLY_TOOLS: ToolMap = {
  owner_settings: createOwnerSettingsTool(OWNER_SETTINGS_SECTIONS),
};

/** Lazy group attachments and stored group history exist only inside a registered family group. */
export const FAMILY_ONLY_TOOLS: ToolMap = {
  import_telegram_attachment: importTelegramAttachment as unknown as AnyToolDefinition,
  list_group_history: listGroupHistory as unknown as AnyToolDefinition,
  list_telegram_attachments: listTelegramAttachments as unknown as AnyToolDefinition,
};

export const TRUSTED_MODE_TOOL_NAMES = Object.keys(TRUSTED_MODE_TOOLS).sort();
export const PRIVATE_ONLY_TOOL_NAMES = Object.keys(PRIVATE_ONLY_TOOLS).sort();
export const OWNER_ONLY_TOOL_NAMES = Object.keys(OWNER_ONLY_TOOLS).sort();
export const FAMILY_ONLY_TOOL_NAMES = Object.keys(FAMILY_ONLY_TOOLS).sort();
