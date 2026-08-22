/**
 * Turn-scoped Eve skill visibility resolver.
 *
 * Exports:
 * - `createConversationSkillResolver`: injectable private/group skill-set resolver.
 * - `resolveConversationSkills`: production resolver using live PostgreSQL grants.
 */
import type { SessionAuth } from "eve/context";
import type { SkillDefinition } from "eve/skills";

import { AppError } from "../app-error.js";
import { resolveConversationEnvironment } from "../conversation-environment.js";
import { IMAGE_GENERATION_AVAILABLE } from "../image-generation/image-generation-availability.js";
import {
  IMAGE_GENERATION_SKILL_DEFINITION,
  IMAGE_GENERATION_SKILL_NAME,
} from "../image-generation/image-generation-skill.js";
import { resolveExternalGroupToolPolicy } from "../tool-policy/external-group-policy.js";
import { resolveExternalGroupSkillPolicy } from "../tool-policy/external-group-policy.js";
import { selectGroupSafeSkillDefinitions } from "./group-skill-definitions.js";
import type { GroupSafeSkillName } from "./group-skill-catalog.js";
import { groupSkillPolicyRepository } from "./group-skill-repository.js";
import { TRUSTED_GOOGLE_WORKSPACE_SKILL_DEFINITIONS } from "./trusted-google-workspace-skills.js";

interface ConversationSkillResolverDependencies {
  loadGroupSkillAllowlist(groupId: string): Promise<ReadonlySet<GroupSafeSkillName>>;
}

interface ConversationSkillResolverOptions {
  scheduledRun?: boolean;
  subagent?: boolean;
}

export function createConversationSkillResolver(
  dependencies: ConversationSkillResolverDependencies,
) {
  return async function resolveSkills(
    auth: SessionAuth,
    options: ConversationSkillResolverOptions = {},
  ): Promise<Record<string, SkillDefinition>> {
    const imageGenerationEnabled = IMAGE_GENERATION_AVAILABLE &&
      options.scheduledRun !== true && options.subagent !== true;
    const environment = resolveConversationEnvironment(auth);
    if (environment === "private") {
      return {
        ...(imageGenerationEnabled
          ? { [IMAGE_GENERATION_SKILL_NAME]: IMAGE_GENERATION_SKILL_DEFINITION }
          : {}),
        ...TRUSTED_GOOGLE_WORKSPACE_SKILL_DEFINITIONS,
        ...selectGroupSafeSkillDefinitions(new Set<GroupSafeSkillName>(["pohuy"])),
      };
    }

    if (environment === "external") {
      const tools = resolveExternalGroupToolPolicy(auth);
      return {
        ...selectGroupSafeSkillDefinitions(resolveExternalGroupSkillPolicy(auth)),
        ...(imageGenerationEnabled && tools.restricted && tools.allowed.has("generate_image")
          ? { [IMAGE_GENERATION_SKILL_NAME]: IMAGE_GENERATION_SKILL_DEFINITION }
          : {}),
      };
    }

    const groupId = auth.current?.attributes.groupId;
    if (typeof groupId !== "string") {
      throw new AppError(
        "AGENT_GROUP_SKILL_CONTEXT_INVALID",
        "Не удалось определить группу для загрузки skills",
      );
    }
    const granted = selectGroupSafeSkillDefinitions(
      await dependencies.loadGroupSkillAllowlist(groupId),
    );
    return {
      ...(imageGenerationEnabled
        ? { [IMAGE_GENERATION_SKILL_NAME]: IMAGE_GENERATION_SKILL_DEFINITION }
        : {}),
      ...TRUSTED_GOOGLE_WORKSPACE_SKILL_DEFINITIONS,
      ...granted,
    };
  };
}

export const resolveConversationSkills = createConversationSkillResolver({
  loadGroupSkillAllowlist: (groupId) =>
    groupSkillPolicyRepository.loadGroupSkillAllowlist(groupId),
});
