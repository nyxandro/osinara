/**
 * The tools a delegated child turn may hold.
 *
 * Export:
 * - `SUBAGENT_TOOL_NAMES`: research, reading and sandbox work; nothing that changes the family's
 *   settings, memory, schedules or groups, or posts into the chat. A child that needs the person's
 *   answer says so in its result, and the root asks.
 *
 * A child mostly reads untrusted pages, and text there can read as an instruction. It used to get
 * the root's surface minus a list of exceptions, so every new administration tool reached it by
 * default: it could set up a daily scenario carrying a page's task, edit or delete memory, reset
 * the conversation. A list of what it may do keeps a new tool off it until someone decides
 * otherwise. Changes outside the sandbox stay with the root, which talks to the person and reads
 * the child's result first. Google Workspace stays: its changes already wait for the owner's button.
 */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "execute_google_workspace",
  "get_current_time",
  "get_memory_source",
  "glob",
  "grep",
  "import_telegram_attachment",
  "inspect_workspace_image",
  "list_agent_schedules",
  "list_group_history",
  "list_memories",
  "list_memory_threads",
  "list_proactive_deliveries",
  "list_telegram_attachments",
  "load_skill",
  "read_file",
  "read_memory_thread",
  "read_profile_view",
  "read_scheduled_group_history",
  "search_memories",
  "search_memory_threads",
  "todo",
  "web_fetch",
  "web_search",
  "write_file",
]);
