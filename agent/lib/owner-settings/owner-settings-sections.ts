/**
 * Sections of the owner's settings door (#459) and the tool behind each one.
 *
 * Exports:
 * - `OWNER_SETTINGS_TOOL_NAME`, `OWNER_SETTINGS_SECTION_TOOLS`, `OwnerSettingsSection`.
 * - `OWNER_SETTINGS_SECTIONS`, `OWNER_SETTINGS_SCHEDULED_SECTIONS`: a live turn of the owner, and a scheduled
 *   run, which has had neither network access nor API keys (nobody is there to confirm or send one).
 * - `ownerSettingsCardAction`: a call through the door as the call it carries, for its confirmation card.
 *
 * Kept free of the tools themselves, so the confirmation card can read it without loading them.
 */
export const OWNER_SETTINGS_TOOL_NAME = "owner_settings";

export const OWNER_SETTINGS_SECTION_TOOLS = {
  groups: "manage_telegram_group",
  group_schedules: "manage_external_group_schedule",
  invitations: "manage_family_invitation",
  guests: "manage_guest_access",
  group_profiles: "manage_profile_projection",
  network: "manage_network_access",
  api_keys: "manage_api_keys",
} as const;

export type OwnerSettingsSection = keyof typeof OWNER_SETTINGS_SECTION_TOOLS;

export const OWNER_SETTINGS_SECTIONS = Object.keys(OWNER_SETTINGS_SECTION_TOOLS) as OwnerSettingsSection[];
export const OWNER_SETTINGS_SCHEDULED_SECTIONS: readonly OwnerSettingsSection[] = [
  "groups", "group_schedules", "invitations", "guests", "group_profiles",
];

export function isOwnerSettingsSection(value: unknown): value is OwnerSettingsSection {
  return typeof value === "string" && Object.hasOwn(OWNER_SETTINGS_SECTION_TOOLS, value);
}

interface CardAction {
  readonly input: Readonly<Record<string, unknown>>;
  readonly toolName: string;
}

/** The call inside the door is what the owner confirms; anything else passes unchanged. */
export function ownerSettingsCardAction<Action extends CardAction>(action: Action): Action {
  if (action.toolName !== OWNER_SETTINGS_TOOL_NAME) return action;
  const { call, section } = action.input;
  if (!isOwnerSettingsSection(section) || typeof call !== "object" || call === null || Array.isArray(call)) return action;
  return { ...action, input: call as Record<string, unknown>, toolName: OWNER_SETTINGS_SECTION_TOOLS[section] };
}
