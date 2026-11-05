/**
 * The owner's settings door (#459): one small tool in place of six administration tools.
 *
 * Exports:
 * - `createOwnerSettingsTool`: the door over the given sections.
 * - `ownerSettingsManual`: a section's exact contract.
 * - `OWNER_SETTINGS_SECTIONS`, `OWNER_SETTINGS_SCHEDULED_SECTIONS`: re-exported section lists.
 *
 * Key constructs:
 * - The six tools cost ~12 thousand characters on every turn of the owner and are used a few times a
 *   month. Loading them on demand would change the tool set at the head of the request, and the
 *   model hub (OpenAI chat completions, no `tool_search`/`defer_loading`) would then recompute the
 *   whole conversation. A door keeps the head unchanged: a section's contract comes as a tool result,
 *   at the end of the history, and the call runs through the section's own tool.
 * - The contract is generated from the tool itself, in the form the provider would get it, so it
 *   cannot drift from the code. A call is checked by that schema first, as the provider did before.
 * - The section's own confirmation, checks and refusals apply unchanged; a tool that checks its
 *   confirmation finds it under the door's call (`withConfirmedCall`). The door is not replay-safe: two
 *   sections behind it are not, and a call cut by a crash must come back as of unknown outcome.
 * - Its input schema is plain JSON: converted from zod, every object would forbid unknown fields, and
 *   `call` would read as an empty object only.
 */
import { asSchema } from "ai";

import { defineTool, type ToolDefinition } from "../../runtime/tool.js";
import type { StandardIssue, StandardSchemaV1 } from "../../runtime/standard-schema.js";
import { AppError, isAppError } from "../app-error.js";
import { ModelFacingError } from "../model-facing-error.js";
import { withConfirmedCall } from "../require-tool-approval-evidence.js";
import {
  isOwnerSettingsSection,
  OWNER_SETTINGS_SCHEDULED_SECTIONS,
  OWNER_SETTINGS_SECTION_TOOLS,
  OWNER_SETTINGS_SECTIONS,
  OWNER_SETTINGS_TOOL_NAME,
  type OwnerSettingsSection,
} from "../owner-settings/owner-settings-sections.js";
import manageApiKeys from "./manage_api_keys.js";
import manageExternalGroupSchedule from "./manage_external_group_schedule.js";
import manageFamilyInvitation from "./manage_family_invitation.js";
import manageNetworkAccess from "./manage_network_access.js";
import manageProfileProjection from "./manage_profile_projection.js";
import manageTelegramGroup from "./manage_telegram_group.js";

export { OWNER_SETTINGS_SCHEDULED_SECTIONS, OWNER_SETTINGS_SECTIONS } from "../owner-settings/owner-settings-sections.js";

type AnyToolDefinition = ToolDefinition<any, any>;

const SECTION_TOOLS: Readonly<Record<OwnerSettingsSection, AnyToolDefinition>> = {
  groups: manageTelegramGroup as unknown as AnyToolDefinition,
  group_schedules: manageExternalGroupSchedule as unknown as AnyToolDefinition,
  invitations: manageFamilyInvitation as unknown as AnyToolDefinition,
  group_profiles: manageProfileProjection as unknown as AnyToolDefinition,
  network: manageNetworkAccess as unknown as AnyToolDefinition,
  api_keys: manageApiKeys as unknown as AnyToolDefinition,
};

const SECTION_PURPOSES: Readonly<Record<OwnerSettingsSection, string>> = {
  groups: "Telegram groups of the family: status, permissions, skills, a new context, registration",
  group_schedules: "automations that post into an external group",
  invitations: "family invitations and candidates waiting for confirmation",
  group_profiles: "facts of an external group in its participants' personal profiles",
  network: "network access of the sandbox to the owner's addresses",
  api_keys: "API keys that skills use without seeing them",
};

// What a section's own description calls the tools of the other sections, by their section here.
const NAMES = Object.fromEntries(Object.entries(OWNER_SETTINGS_SECTION_TOOLS).map(([section, tool]) => [tool, section]));

const INPUT_INVALID = "AGENT_OWNER_SETTINGS_INPUT_INVALID";
const SECTION_FORBIDDEN = "AGENT_OWNER_SETTINGS_SECTION_FORBIDDEN";
const SECTION_INPUT_REFUSAL = /_INPUT_INVALID$/u;

export async function ownerSettingsManual(section: OwnerSettingsSection) {
  const definition = SECTION_TOOLS[section];
  return {
    section,
    description: definition.description,
    inputSchema: await asSchema(definition.inputSchema as Parameters<typeof asSchema>[0]).jsonSchema,
    names: NAMES,
    next: `Call ${OWNER_SETTINGS_TOOL_NAME} with {"section":"${section}","call":{...}}, the call following inputSchema exactly.`,
  };
}

function fieldOf(path: StandardIssue["path"]): string {
  return (path ?? []).map((part) => String(typeof part === "object" ? part.key : part)).join(".") || "call";
}

/** The section's schema reads the call as the provider did: the parsed value, defaults included. */
async function parseCall(section: OwnerSettingsSection, call: unknown): Promise<
  { readonly issues: string } | { readonly value: Record<string, unknown> }
> {
  const schema = SECTION_TOOLS[section].inputSchema as unknown as StandardSchemaV1;
  const result = await schema["~standard"].validate(call);
  if (result.issues !== undefined) {
    return { issues: result.issues.map((issue) => `${fieldOf(issue.path)}: ${issue.message}`).join("; ") };
  }
  return { value: result.value as Record<string, unknown> };
}

function requestOf(input: unknown): { readonly call?: unknown; readonly section: OwnerSettingsSection } | null {
  if (typeof input !== "object" || input === null) return null;
  const { call, section } = input as { call?: unknown; section?: unknown };
  return isOwnerSettingsSection(section) ? { call, section } : null;
}

function description(sections: readonly OwnerSettingsSection[]): string {
  return [
    "The owner's settings, one section at a time:",
    sections.map((section) => `${section} — ${SECTION_PURPOSES[section]}`).join("; ") + ".",
    `A call is {"section":"<section>","call":{...}}; the section's own checks and confirmation buttons apply. When the loaded skill does not give the exact call you need, first call {"section":"<section>"} alone: it returns the section's contract, its description and inputSchema, as for a separate tool.`,
    "A tool name inside a section's description stands for its section here, as the contract's names map shows.",
  ].join(" ");
}

function inputRefusal(reason: string, correction: string, cause?: unknown): ModelFacingError {
  return new ModelFacingError(
    { category: "input", code: INPUT_INVALID, correction, reason, retryable: true, sideEffectStatus: "not_started" },
    cause === undefined ? undefined : { cause },
  );
}

/** A section's input refusal speaks of its own tool; the model has to send it wrapped in the door. */
function wrappedSectionRefusal(section: OwnerSettingsSection, error: AppError): ModelFacingError {
  const contract = error instanceof ModelFacingError ? error.contract : null;
  const reason = contract?.reason ?? error.message.replace(new RegExp(`^${error.code}:\\s*`, "u"), "");
  return new ModelFacingError({
    category: "input",
    code: error.code,
    correction: `Исправьте поля call по контракту раздела (его покажет вызов {"section":"${section}"}) и повторите один раз как {"section":"${section}","call":{...}}.`,
    ...(contract?.example === undefined ? {} : { example: contract.example }),
    ...(contract?.field === undefined ? {} : { field: contract.field }),
    reason,
    retryable: true,
    sideEffectStatus: "not_started",
  }, { cause: error });
}

export function createOwnerSettingsTool(sections: readonly OwnerSettingsSection[]): AnyToolDefinition {
  const [first, ...rest] = sections;
  if (first === undefined) throw new Error("OWNER_SETTINGS_SECTIONS_EMPTY");
  const offered = (section: OwnerSettingsSection) => sections.includes(section);
  return defineTool({
    description: description(sections),
    inputSchema: {
      type: "object",
      properties: {
        section: { type: "string", enum: [first, ...rest] },
        call: { type: "object", description: "A call of the section that follows its inputSchema; leave it out to read the section's contract" },
      },
      required: ["section"],
      additionalProperties: false,
    },
    // Reading a contract changes nothing; a call asks what its own section asks.
    async approval(ctx) {
      const request = requestOf(ctx.toolInput);
      if (request === null || request.call === undefined || !offered(request.section)) return "not-applicable";
      const parsed = await parseCall(request.section, request.call);
      // A malformed call goes on to execution, whose refusal reaches the model; thrown here, it would end the turn.
      if (!("value" in parsed)) return "not-applicable";
      const approval = SECTION_TOOLS[request.section].approval;
      return approval === undefined
        ? "not-applicable"
        : await approval({ ...ctx, toolInput: parsed.value, toolName: OWNER_SETTINGS_SECTION_TOOLS[request.section] });
    },
    async execute(input, ctx) {
      const request = requestOf(input);
      if (request === null) {
        throw inputRefusal(
          `Не указан раздел настроек; разделы: ${sections.join(", ")}`,
          `Повторите вызов с section из списка: {"section":"${first}"}.`,
        );
      }
      if (!offered(request.section)) {
        throw new AppError(SECTION_FORBIDDEN, `Раздел ${request.section} недоступен здесь; доступны: ${sections.join(", ")}`);
      }
      if (request.call === undefined) return await ownerSettingsManual(request.section);
      const parsed = await parseCall(request.section, request.call);
      if (!("value" in parsed)) {
        throw inputRefusal(
          `Вызов раздела ${request.section} не прошёл его схему: ${parsed.issues}`,
          `Прочитайте контракт раздела вызовом {"section":"${request.section}"} и повторите один раз как {"section":"${request.section}","call":{...}} по его inputSchema.`,
        );
      }
      // The person confirmed this door call; a section that checks its confirmation looks for this one.
      const sectionContext = withConfirmedCall(ctx, { input, toolName: ctx.toolName });
      try {
        return await SECTION_TOOLS[request.section].execute(parsed.value, sectionContext);
      } catch (error) {
        if (isAppError(error) && SECTION_INPUT_REFUSAL.test(error.code)) throw wrappedSectionRefusal(request.section, error);
        throw error;
      }
    },
  });
}
