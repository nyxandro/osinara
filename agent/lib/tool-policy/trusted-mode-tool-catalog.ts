/**
 * Trusted private and family tool catalogs.
 *
 * Exports:
 * - `TRUSTED_MODE_TOOLS`: shared private/family tool definitions.
 * - `PRIVATE_ONLY_TOOLS`, `FAMILY_ONLY_TOOLS`: trust-zone-specific definitions.
 * - Sorted tool-name arrays used by policy contracts.
 */
import type { ToolDefinition } from "eve/tools";

import executeGoogleWorkspace from "../tools/execute_google_workspace.js";
import exportMemory from "../tools/export_memory.js";
import generateImage from "../tools/generate_image.js";
import getCurrentTime from "../tools/get_current_time.js";
import getMemorySource from "../tools/get_memory_source.js";
import importTelegramAttachment from "../tools/import_telegram_attachment.js";
import inspectWorkspaceImage from "../tools/inspect_workspace_image.js";
import listAgentSchedules from "../tools/list_agent_schedules.js";
import listGroupHistory from "../tools/list_group_history.js";
import listMemories from "../tools/list_memories.js";
import listMemoryThreads from "../tools/list_memory_threads.js";
import listPendingFamilyInvitations from "../tools/list_pending_family_invitations.js";
import listProactiveDeliveries from "../tools/list_proactive_deliveries.js";
import listReminders from "../tools/list_reminders.js";
import listTelegramAttachments from "../tools/list_telegram_attachments.js";
import manageAgentSchedule from "../tools/manage_agent_schedule.js";
import manageBehaviorPreference from "../tools/manage_behavior_preference.js";
import manageExternalGroupSchedule from "../tools/manage_external_group_schedule.js";
import manageFamilyInvitation from "../tools/manage_family_invitation.js";
import manageGoogleWorkspaceConnection from "../tools/manage_google_workspace_connection.js";
import manageMemory from "../tools/manage_memory.js";
import manageMemoryConflict from "../tools/manage_memory_conflict.js";
import manageMemoryThread from "../tools/manage_memory_thread.js";
import manageProfileProjection from "../tools/manage_profile_projection.js";
import manageReminder from "../tools/manage_reminder.js";
import manageTelegramGroup from "../tools/manage_telegram_group.js";
import notificationSettings from "../tools/notification_settings.js";
import readMemoryThread from "../tools/read_memory_thread.js";
import readProfileView from "../tools/read_profile_view.js";
import remember from "../tools/remember.js";
import searchMemories from "../tools/search_memories.js";
import searchMemoryThreads from "../tools/search_memory_threads.js";
import sendWorkspaceFile from "../tools/send_workspace_file.js";
import startNewContext from "../tools/start_new_context.js";
import { IMAGE_GENERATION_AVAILABLE } from "../image-generation/image-generation-availability.js";

type AnyToolDefinition = ToolDefinition<any, any>;
type ToolMap = Readonly<Record<string, AnyToolDefinition>>;

/** Tools whose authorization boundary accepts both a private chat and a closed family group. */
export const TRUSTED_MODE_TOOLS: ToolMap = {
  execute_google_workspace: executeGoogleWorkspace as unknown as AnyToolDefinition,
  ...(IMAGE_GENERATION_AVAILABLE
    ? { generate_image: generateImage as unknown as AnyToolDefinition }
    : {}),
  get_current_time: getCurrentTime as unknown as AnyToolDefinition,
  inspect_workspace_image: inspectWorkspaceImage as unknown as AnyToolDefinition,
  list_agent_schedules: listAgentSchedules as unknown as AnyToolDefinition,
  list_memories: listMemories as unknown as AnyToolDefinition,
  list_memory_threads: listMemoryThreads as unknown as AnyToolDefinition,
  list_proactive_deliveries: listProactiveDeliveries as unknown as AnyToolDefinition,
  list_reminders: listReminders as unknown as AnyToolDefinition,
  manage_agent_schedule: manageAgentSchedule as unknown as AnyToolDefinition,
  manage_behavior_preference: manageBehaviorPreference as unknown as AnyToolDefinition,
  manage_google_workspace_connection: manageGoogleWorkspaceConnection as unknown as AnyToolDefinition,
  manage_memory: manageMemory as unknown as AnyToolDefinition,
  manage_memory_conflict: manageMemoryConflict as unknown as AnyToolDefinition,
  manage_memory_thread: manageMemoryThread as unknown as AnyToolDefinition,
  manage_reminder: manageReminder as unknown as AnyToolDefinition,
  read_memory_thread: readMemoryThread as unknown as AnyToolDefinition,
  read_profile_view: readProfileView as unknown as AnyToolDefinition,
  remember: remember as unknown as AnyToolDefinition,
  search_memories: searchMemories as unknown as AnyToolDefinition,
  search_memory_threads: searchMemoryThreads as unknown as AnyToolDefinition,
  send_workspace_file: sendWorkspaceFile as unknown as AnyToolDefinition,
  start_new_context: startNewContext as unknown as AnyToolDefinition,
};

/** Owner administration and personal-only surfaces that require the owner's private chat. */
export const PRIVATE_ONLY_TOOLS: ToolMap = {
  export_memory: exportMemory as unknown as AnyToolDefinition,
  get_memory_source: getMemorySource as unknown as AnyToolDefinition,
  list_pending_family_invitations: listPendingFamilyInvitations as unknown as AnyToolDefinition,
  manage_external_group_schedule: manageExternalGroupSchedule as unknown as AnyToolDefinition,
  manage_family_invitation: manageFamilyInvitation as unknown as AnyToolDefinition,
  manage_profile_projection: manageProfileProjection as unknown as AnyToolDefinition,
  manage_telegram_group: manageTelegramGroup as unknown as AnyToolDefinition,
  notification_settings: notificationSettings as unknown as AnyToolDefinition,
};

/** Lazy group attachments and stored group history exist only inside a registered family group. */
export const FAMILY_ONLY_TOOLS: ToolMap = {
  import_telegram_attachment: importTelegramAttachment as unknown as AnyToolDefinition,
  list_group_history: listGroupHistory as unknown as AnyToolDefinition,
  list_telegram_attachments: listTelegramAttachments as unknown as AnyToolDefinition,
};

export const TRUSTED_MODE_TOOL_NAMES = Object.keys(TRUSTED_MODE_TOOLS).sort();
export const PRIVATE_ONLY_TOOL_NAMES = Object.keys(PRIVATE_ONLY_TOOLS).sort();
export const FAMILY_ONLY_TOOL_NAMES = Object.keys(FAMILY_ONLY_TOOLS).sort();
