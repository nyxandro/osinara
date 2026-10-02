/** Turn-scoped skill visibility: installed catalog for trusted chats, exact grants for groups. */
import type { SessionAuth } from "../../runtime/context.js";
import type { SkillDefinition } from "../../runtime/skills/definition.js";
import { resolveConversationEnvironment } from "../conversation-environment.js";
import { IMAGE_GENERATION_AVAILABLE } from "../image-generation/image-generation-availability.js";
import { IMAGE_GENERATION_SKILL_DEFINITION, IMAGE_GENERATION_SKILL_NAME } from "../image-generation/image-generation-skill.js";
import { resolveExternalGroupToolPolicy, resolveExternalGroupSkillPolicy } from "../tool-policy/external-group-policy.js";
import { selectGroupSafeSkillDefinitions } from "./group-skill-definitions.js";
import { GROUP_SAFE_SKILL_NAMES } from "./group-skill-catalog.js";

export async function resolveConversationSkills(
  auth: SessionAuth,
  options: { scheduledRun?: boolean; subagent?: boolean } = {},
): Promise<Record<string, SkillDefinition>> {
  const external = resolveConversationEnvironment(auth) === "external";
  const names = external ? resolveExternalGroupSkillPolicy(auth) : new Set(GROUP_SAFE_SKILL_NAMES);
  const tools = resolveExternalGroupToolPolicy(auth);
  const imageGenerationEnabled = IMAGE_GENERATION_AVAILABLE &&
    options.scheduledRun !== true && options.subagent !== true &&
    (!external || (tools.restricted && tools.allowed.has("generate_image")));
  return {
    ...selectGroupSafeSkillDefinitions(names),
    ...(imageGenerationEnabled ? { [IMAGE_GENERATION_SKILL_NAME]: IMAGE_GENERATION_SKILL_DEFINITION } : {}),
  };
}
