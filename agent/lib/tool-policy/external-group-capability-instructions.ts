/**
 * External-group capability instructions.
 *
 * Export:
 * - `externalGroupCapabilityInstructions`: binds the turn to the tools sent with its request and the
 *   skills of its Available skills section.
 * - `ExternalGroupCapabilityInstructionOptions`: whether the application core (delegation) is issued.
 *
 * The exact surface is the tool set of the request itself: the runtime sends only the descriptors
 * this group may execute, and the skills section lists only its granted skills. Listing them again
 * here cost about 4,800 characters in every request of a fully granted group.
 */
export interface ExternalGroupCapabilityInstructionOptions {
  includeApplicationCore: boolean;
}

export function externalGroupCapabilityInstructions(options: ExternalGroupCapabilityInstructionOptions): string {
  return [
    "<external_group_capabilities>",
    "# Capabilities of the current external group",
    "",
    "In this turn you have only the tools sent with this request and only the skills from the Available skills section. Do not call, offer or claim that you can use anything beyond them. The limits written in a tool's description and schema are part of the permission too: for example, a permitted action does not permit the neighbouring ones.",
    ...(options.includeApplicationCore
      ? ["", "The main agent may delegate a complex part as a subtask; the child agent gets the same data boundaries and permissions, but does not delegate again and does not save long-term memory."]
      : []),
    "",
    "A permitted skill does not grant anyone else's authorization. If it needs an external connection that is not available here, say so; personal and family connections are not passed to the group.",
    "</external_group_capabilities>",
  ].join("\n");
}
