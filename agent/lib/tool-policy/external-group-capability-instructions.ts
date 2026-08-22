/**
 * Generated external-group capability instructions.
 *
 * Export:
 * - `externalGroupCapabilityInstructions`: renders the exact effective model capability surface.
 * - `ExternalGroupCapabilityInstructionOptions`: independently issued core capability switches.
 */
import {
  EXTERNAL_GROUP_CAPABILITY_CATALOG,
  SANDBOX_FILE_CAPABILITY_CATALOG,
  type ExternalGroupToolName,
} from "./group-tool-catalog.js";
import type { GroupSafeSkillName } from "../group-skills/group-skill-catalog.js";
import { IMAGE_GENERATION_AVAILABLE } from "../image-generation/image-generation-availability.js";

function modelInvocation(name: ExternalGroupToolName | string): string {
  const memoryAction = /^manage_memory\.(edit|delete|undo)$/u.exec(name)?.[1];
  if (memoryAction) return `\`manage_memory\` с \`action=${memoryAction}\``;
  const threadAction = /^manage_memory_thread\.(complete|reactivate)$/u.exec(name)?.[1];
  return threadAction
    ? `\`manage_memory_thread\` с \`action=${threadAction}\``
    : `\`${name}\``;
}

export interface ExternalGroupCapabilityInstructionOptions {
  includeApplicationCore: boolean;
  scheduledHistory: boolean;
  scheduledRun: boolean;
}

const DEFAULT_INSTRUCTION_OPTIONS: ExternalGroupCapabilityInstructionOptions = {
  includeApplicationCore: false,
  scheduledHistory: false,
  scheduledRun: false,
};

export function externalGroupCapabilityInstructions(
  allowed: ReadonlySet<ExternalGroupToolName>,
  skills: ReadonlySet<GroupSafeSkillName>,
  options: ExternalGroupCapabilityInstructionOptions = DEFAULT_INSTRUCTION_OPTIONS,
): string {
  // Catalog order makes the prompt deterministic while the set keeps authorization exact.
  const effectiveCapabilities = [
    ...SANDBOX_FILE_CAPABILITY_CATALOG,
    ...EXTERNAL_GROUP_CAPABILITY_CATALOG.filter(({ name }) =>
      allowed.has(name) && !(name === "generate_image" && (
        options.scheduledRun || !IMAGE_GENERATION_AVAILABLE
      ))
    ),
  ];
  const applicationCore = options.includeApplicationCore
    ? [
      { name: "read_profile_view", usage: "прочитать выданный текущему чату снимок профиля по profileViewRef" },
      ...(options.scheduledRun
        ? []
        : [{ name: "manage_behavior_preference", usage: "прочитать или изменить стиль ответов текущего чата по явной просьбе" }]),
      ...(options.scheduledHistory
        ? [{ name: "read_scheduled_group_history", usage: "последовательно прочитать разрешённый snapshot истории scheduled run" }]
        : []),
    ]
    : [];
  const completeSurface = [...effectiveCapabilities, ...applicationCore];
  const usage = completeSurface
    .map(({ name, usage: description }) => `- ${modelInvocation(name)}: ${description}.`)
    .join("\n");
  const effectiveAllowlist = completeSurface.map(({ name }) => modelInvocation(name)).join(", ");
  const effectiveSkills = new Set<string>(skills);
  if (IMAGE_GENERATION_AVAILABLE && !options.scheduledRun && allowed.has("generate_image")) {
    effectiveSkills.add("imagegen");
  }
  const skillUsage = [...effectiveSkills]
    .map((name) => `- \`load_skill\` с \`skill=${name}\`: загрузить инструкции разрешённого skill \`${name}\`.`)
    .join("\n");
  const skillAllowlist = [...effectiveSkills].map((name) => `\`${name}\``).join(", ");
  // Naming an action-level tool that was never granted would reintroduce the capability the
  // surrounding prompt deliberately omits, so this clarification is itself conditional.
  const memoryActions = [...allowed].some((name) => name.startsWith("manage_memory."))
    ? " Для `manage_memory` разрешены только явно перечисленные выше actions; наличие одного action не разрешает остальные."
    : "";

  return `
<external_group_capabilities>
# Effective capabilities текущей внешней группы

Это полный и точный список реально разрешённых capabilities для текущего хода:
Effective allowlist: ${effectiveAllowlist}.

${usage}

  ${effectiveSkills.size === 0 ? "" : `Effective skill allowlist: ${skillAllowlist}.\n\n${skillUsage}`}

Используй capabilities только для указанного usage. Не вызывай, не предлагай и не утверждай, что можешь использовать инструменты, не перечисленные выше.${memoryActions}

Trusted-only skills Google Workspace не доступны во внешней группе: не предлагай и не используй их, даже если устаревший static descriptor оказался виден.
</external_group_capabilities>
`.trim();
}
