/**
 * External Telegram group capability catalog.
 *
 * Exports:
 * - `EXTERNAL_GROUP_TOOL_NAMES`: persisted direct tools and action-level capabilities.
 * - `ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES`: native tools confined by the group mount.
 * - `CONTROLLED_TOOL_NAMES`: static tools overridden fail-closed for external groups.
 * - `ExternalGroupToolName`: validated persisted allowlist value.
 */
export const EXTERNAL_GROUP_TOOL_NAMES = [
  "inspect_workspace_image",
  "list_memories",
  "manage_memory.delete",
  "manage_memory.edit",
  "manage_memory.undo",
  "remember",
  "remove_group_file",
  "search_memories",
  "send_workspace_file",
] as const;

export type ExternalGroupToolName = (typeof EXTERNAL_GROUP_TOOL_NAMES)[number];

export const ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES = [
  "glob",
  "grep",
  "read_file",
  "write_file",
] as const;

export const CONTROLLED_TOOL_NAMES = [
  "export_memory",
  "google_workspace",
  "inspect_workspace_image",
  "list_family_members",
  "list_memories",
  "list_pending_family_invitations",
  "list_reminders",
  "list_tasks",
  "manage_behavior_preference",
  "manage_family_invitation",
  "manage_memory",
  "manage_reminder",
  "manage_task",
  "manage_telegram_group",
  "notification_settings",
  "remember",
  "search_memories",
  "send_workspace_file",
  "start_new_context",
  "ask_question",
  "bash",
  "todo",
  "web_fetch",
  "web_search",
  "load_skill",
] as const;

export function isExternalGroupToolName(value: string): value is ExternalGroupToolName {
  return (EXTERNAL_GROUP_TOOL_NAMES as readonly string[]).includes(value);
}
