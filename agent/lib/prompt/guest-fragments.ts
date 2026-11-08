/**
 * The private-chat mode block of a guest (#471): someone outside the family whom the owner let in.
 *
 * Exports:
 * - `GuestModeFacts`: what the owner turned off for this guest and what of the owner's they were given (#474), from
 *   the live guest policy.
 * - `GUEST_INTRODUCTION`, `GUEST_MEMORY`, `GUEST_CHILD_MEMORY`: who the person is and whose memory there is.
 * - `guestAdministrationRules`: who decides what a guest has, what is off for this one and what they were given.
 *
 * A guest lives in a family of their own, so every scope of the chat is theirs alone; the wording only keeps
 * the model from treating them as the owner's family.
 */
import { apiKeyEnvironmentNames } from "../api-keys/api-key-contract.js";

export interface GuestModeFacts {
  readonly disabledSkills: readonly string[];
  readonly disabledTools: readonly string[];
  readonly grantedApiKeys: readonly string[];
  readonly grantedSkills: readonly string[];
}

export const GUEST_INTRODUCTION = `## A guest

This person is a guest of the agent's owner, not a member of the owner's family. Their memory, files, skills, reminders, scenarios and Google connection are theirs alone and separate from everyone else's; nothing of the owner's family is visible here, except the skills and API keys the owner gave this guest, and nothing of theirs reaches anyone else. Do not speak to them as part of a family, and do not claim to know the owner's family or other people.`;

export const GUEST_MEMORY = `## Memory

Only this guest's own memory is available, for reading and writing. Save their facts to the personal scope; the scope named family holds nothing of anyone else's here and is not needed.

Export personal memory only through \`export_memory\`; do not retell the whole export through the model.`;

// A child reads memory and leaves saving and export to the agent that called it.
export const GUEST_CHILD_MEMORY = `## Memory

Only this guest's own memory is available, for reading.`;

function namesList(names: readonly string[]): string {
  return names.map((name) => `\`${name}\``).join(", ");
}

function grantedRules(facts: GuestModeFacts): string {
  const given = [
    facts.grantedSkills.length > 0 ? `skills ${namesList(facts.grantedSkills)}` : null,
    facts.grantedApiKeys.length > 0
      ? `API keys ${facts.grantedApiKeys.map((name) => `\`${name}\` (\`${apiKeyEnvironmentNames(name).apiKey}\`)`).join(", ")}`
      : null,
  ].filter((part): part is string => part !== null);
  if (given.length === 0) return "The owner has not given this guest any of the owner's skills or API keys.";
  return `The owner gave this guest ${given.join(" and ")}. Use them like the guest's own, but they are not in the guest's skill library: they cannot be changed, turned off or deleted here, and only the owner gives or takes them back. When a given key is refused, say that the owner can grant it again.`;
}

export function guestAdministrationRules(facts: GuestModeFacts): string {
  const off = [
    facts.disabledTools.length > 0 ? `tools ${namesList(facts.disabledTools)}` : null,
    facts.disabledSkills.length > 0 ? `skills ${namesList(facts.disabledSkills)}` : null,
  ].filter((part): part is string => part !== null);
  return [
    "## Administration",
    "The agent's owner decides what a guest has: the access itself, which tools and skills are turned off, and which skills and API keys of the owner's are given. The guest cannot change that here; when asked, say that the owner of the agent manages it. Telegram groups, invitations, adding API keys and access to the owner's devices are not available to a guest.",
    grantedRules(facts),
    off.length > 0
      ? `The owner turned off for this guest: ${off.join("; ")}. When a request needs one of them, say that the owner turned it off for them; never work around it with another tool or a script.`
      : null,
    "The guest keeps their own skills through `manage_skill`, without confirmation buttons; load the service skill `skill-manager` first. Skills they save are theirs alone. Never install a skill with `npx skills add` or by copying files into `$HOME/.agents/skills/`. When the turn carries a notice that the previous task took many tool steps, or the person corrected you during a task that succeeded and is likely to repeat, end the answer with one sentence offering to save it as a skill; not for a one-off task, and not again after the person declined in this conversation.",
  ].filter((part): part is string => part !== null).join("\n\n");
}
