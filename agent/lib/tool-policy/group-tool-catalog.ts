/**
 * External Telegram group capability catalog.
 *
 * Exports:
 * - `EXTERNAL_GROUP_CAPABILITY_CATALOG`: persisted capabilities; what each does is told to the model by its
 *   own tool descriptor, not by this catalog.
 * - `SANDBOX_FILE_CAPABILITY_CATALOG`: same-name guarded runtime capabilities for group workspaces.
 * - Derived capability-name tuples used by validation and execution policy.
 * - `ExternalGroupToolName`: validated persisted allowlist value.
 * - `ExternalGroupCapabilityRequirement`, `externalGroupCapabilityRequirement`: what the active
 *   runtime must offer for a capability to work at all.
 * - `parseExternalGroupToolAllowlist`: validates the complete persisted policy atomically.
 */
/**
 * A runtime property a capability depends on: subscription image generation exists only under one
 * model provider, and image inspection only with a model that accepts images.
 */
export type ExternalGroupCapabilityRequirement = "image_generation" | "vision";

interface ExternalGroupCapability<Name extends string = string> {
  readonly name: Name;
  // Set when the capability works only with a specific runtime, so the owner-facing grant surface
  // can drop it while persisted validation still recognizes a grant made under a previous runtime.
  readonly requires?: ExternalGroupCapabilityRequirement;
}

function capabilityNames<const Catalog extends readonly ExternalGroupCapability[]>(
  catalog: Catalog,
): { readonly [Index in keyof Catalog]: Catalog[Index]["name"] } {
  return catalog.map(({ name }) => name) as {
    readonly [Index in keyof Catalog]: Catalog[Index]["name"];
  };
}

// Persisted grants are action-level where one static descriptor contains distinct side effects.
export const EXTERNAL_GROUP_CAPABILITY_CATALOG = [
  { name: "bash" },
  {
    name: "generate_image",
    requires: "image_generation",
  },
  { name: "import_telegram_attachment" },
  {
    name: "inspect_workspace_image",
    requires: "vision",
  },
  { name: "list_memories" },
  { name: "list_memory_threads" },
  { name: "list_group_history" },
  { name: "manage_memory.delete" },
  { name: "manage_memory.edit" },
  { name: "manage_memory.undo" },
  { name: "manage_memory_thread.complete" },
  { name: "manage_memory_thread.reactivate" },
  { name: "read_memory_thread" },
  { name: "remember" },
  { name: "remove_group_file" },
  { name: "search_memories" },
  { name: "search_memory_threads" },
  { name: "send_voice_message" },
  { name: "send_workspace_file" },
  { name: "web_fetch" },
] as const satisfies readonly ExternalGroupCapability[];

export const EXTERNAL_GROUP_TOOL_NAMES = capabilityNames(
  EXTERNAL_GROUP_CAPABILITY_CATALOG,
);
export type ExternalGroupToolName = (typeof EXTERNAL_GROUP_TOOL_NAMES)[number];

// Persisted validation stays runtime-agnostic on purpose: a grant made while another provider or
// model was active must keep the surrounding policy parseable instead of invalidating every other
// capability.
const CAPABILITY_REQUIREMENTS: ReadonlyMap<string, ExternalGroupCapabilityRequirement> = new Map(
  (EXTERNAL_GROUP_CAPABILITY_CATALOG as readonly ExternalGroupCapability[])
    .flatMap(({ name, requires }) => requires === undefined ? [] : [[name, requires] as const]),
);

export function externalGroupCapabilityRequirement(
  value: string,
): ExternalGroupCapabilityRequirement | null {
  return CAPABILITY_REQUIREMENTS.get(value) ?? null;
}

// Same-name wrappers preserve the native tools' contracts while adding live authorization and exact
// group-root confinement. They remain baseline capabilities and need no persisted grant.
export const SANDBOX_FILE_CAPABILITY_CATALOG = [
  { name: "glob" },
  { name: "grep" },
  { name: "read_file" },
  { name: "write_file" },
] as const satisfies readonly ExternalGroupCapability[];

export const ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES = capabilityNames(
  SANDBOX_FILE_CAPABILITY_CATALOG,
);

export const EXTERNAL_GROUP_BASE_TOOLS = [
  { name: "web_search" },
  { name: "web_fetch" },
  { name: "get_current_time" },
  { name: "todo" },
] as const;

// Every tool is emitted per mode, so an external group never sees a descriptor it cannot use:
// file built-ins come as guarded same-name wrappers, search and page reading as application-
// controlled baseline wrappers, never provider-native search.
export function isExternalGroupToolName(value: string): value is ExternalGroupToolName {
  return (EXTERNAL_GROUP_TOOL_NAMES as readonly string[]).includes(value);
}

export function parseExternalGroupToolAllowlist(
  value: unknown,
): ReadonlySet<ExternalGroupToolName> | null {
  if (!Array.isArray(value)) return null;

  // One unknown or duplicate entry invalidates the complete trusted policy rather than granting a
  // known subset. Registration rejects both shapes, so seeing either means persisted corruption.
  const allowed = new Set<ExternalGroupToolName>();
  for (const name of value) {
    if (typeof name !== "string" || !isExternalGroupToolName(name) || allowed.has(name)) return null;
    allowed.add(name);
  }
  return allowed;
}
