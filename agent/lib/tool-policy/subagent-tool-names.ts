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
 * the child's result first. Google Workspace stays for reading only, see `google-workspace-live-turn.ts`.
 *
 * - `SUBAGENT_TOOL_ACTIONS`: tools a child holds only for reading (#457 folded their separate list
 *   tools into them): it sees them with these actions alone, and any other action is refused.
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
  "list_group_history",
  "list_proactive_deliveries",
  "list_telegram_attachments",
  "load_skill",
  "read_file",
  "read_profile_view",
  "read_scheduled_group_history",
  "search_memories",
  "todo",
  "web_fetch",
  "web_search",
  "write_file",
]);

export const SUBAGENT_TOOL_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  manage_agent_schedule: ["list"],
  manage_memory: ["list"],
  manage_memory_thread: ["list", "search", "read"],
};
