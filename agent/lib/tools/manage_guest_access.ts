/**
 * The owner's guests (#471): people outside the family who use the agent in their own private chat.
 *
 * Export:
 * - `manage_guest_access` (section `guests` of `owner_settings`): list the guests, create a guest link, turn a
 *   guest's tools and skills off or back on, give a guest skills of the owner's library (#474), remove a guest.
 *
 * Key constructs:
 * - A guest link is a family invitation of kind `guest`: the same one-time code, lifetime and durable delivery
 *   to the owner's chat, never shown to the model. Whoever opens it first becomes a guest at once.
 * - Changing or removing a guest names them by `guestUserId` and `guestDisplayName` from the list, so the
 *   confirmation card shows a name and the database rechecks it.
 * - Configure replaces only the lists it is given, so turning a tool off never drops the skills granted to the guest.
 * - Removing a guest republishes the API key grants the sandbox proxy reads, so the guest's keys stop at once.
 * - The guest tool catalog is loaded on call: the tool surface module that defines it imports the owner's door,
 *   which imports this tool.
 */
import { z } from "zod";

import { defineTool } from "../../runtime/tool.js";
import { apiKeyPublisher } from "../api-keys/api-key-projection.js";
import { AppError, isAppError } from "../app-error.js";
import { requirePrivateTelegramOwner } from "../family-context.js";
import { familyRepository } from "../family-repository.js";
import { GROUP_SAFE_SKILL_NAMES } from "../group-skills/group-skill-catalog.js";
import { guestRepository } from "../guests/guest-repository.js";
import { deliverFamilyInvitation } from "../telegram-delivery.js";
import { withCallExamples, type CallExamples } from "../tool-call-examples.js";
import {
  requireAction,
  requiredString,
  requiredUuid,
  requireInputRecord,
  requireOnlyFields,
  toolInputError,
} from "../tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_GUEST_ACCESS_INPUT_INVALID";
const TOOL_ACTIONS = ["list", "invite", "configure", "revoke"] as const;
const NAME_LIST_FIELDS = ["disabledTools", "disabledSkills", "grantedSkills"] as const;
const TOP_LEVEL_FIELDS = ["action", "guestUserId", "guestDisplayName", ...NAME_LIST_FIELDS] as const;
const NAME_LIST_MAX = 100;
const NAME_MAX_LENGTH = 64;

const manageGuestAccessSchema = z.object({
  action: z.enum(TOOL_ACTIONS).describe("Required action: list, invite, configure or revoke."),
  guestUserId: z.string().optional().describe("configure, revoke: the guest's guestUserId from list."),
  guestDisplayName: z.string().optional().describe("configure, revoke: the guest's displayName from list, copied exactly."),
  disabledTools: z.array(z.string()).optional()
    .describe("configure: the new full list of tools turned off for the guest, names from toolCatalog; [] turns every tool back on; omit to keep it."),
  disabledSkills: z.array(z.string()).optional()
    .describe("configure: the new full list of skills turned off for the guest, from builtInSkills or the guest's ownSkills; [] turns every skill back on; omit to keep it."),
  grantedSkills: z.array(z.string()).optional()
    .describe("configure: the new full list of the owner's library skills given to the guest, names from hostSkills; [] takes them all back; omit to keep it."),
}).strict();

function requireTarget(input: Record<string, unknown>) {
  return {
    guestDisplayName: requiredString(input, "guestDisplayName", INPUT_ERROR_CODE, "Пётр", { maxLength: 200 }),
    guestUserId: requiredUuid(input, "guestUserId", INPUT_ERROR_CODE, "гость из manage_guest_access с action=list"),
  };
}

type NameListField = (typeof NAME_LIST_FIELDS)[number];

/** A list the call gives, or undefined when it keeps the current one. */
function optionalNames(input: Record<string, unknown>, key: NameListField): string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > NAME_LIST_MAX ||
    value.some((name) => typeof name !== "string" || name.length === 0 || name.length > NAME_MAX_LENGTH)) {
    toolInputError(
      INPUT_ERROR_CODE,
      `Поле ${key} — полный новый список имён (пустой массив снимает всё), не больше ${NAME_LIST_MAX}. Пример: ["bash"]`,
    );
  }
  return value as string[];
}

function parseInput(raw: unknown) {
  const input = requireInputRecord(raw, "manage_guest_access", INPUT_ERROR_CODE);
  const action = requireAction(input, "manage_guest_access", TOOL_ACTIONS, INPUT_ERROR_CODE);
  // A model may fill the optional fields of other actions in; reading and creating a link use none of them.
  requireOnlyFields(input, TOP_LEVEL_FIELDS, "manage_guest_access", INPUT_ERROR_CODE);
  if (action === "list" || action === "invite") return { action } as const;
  if (action === "revoke") {
    requireOnlyFields(input, ["action", "guestUserId", "guestDisplayName"], "action=revoke", INPUT_ERROR_CODE);
    return { action, target: requireTarget(input) } as const;
  }
  requireOnlyFields(input, TOP_LEVEL_FIELDS, "action=configure", INPUT_ERROR_CODE);
  const target = requireTarget(input);
  const lists = Object.fromEntries(NAME_LIST_FIELDS.flatMap((key) => {
    const names = optionalNames(input, key);
    return names === undefined ? [] : [[key, names]];
  })) as Partial<Record<NameListField, string[]>>;
  if (Object.keys(lists).length === 0) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Передайте хотя бы один список: disabledTools, disabledSkills или grantedSkills. Непереданные списки не меняются. Пример: {\"grantedSkills\":[\"image-gen\"]}",
    );
  }
  return { action, lists, target } as const;
}

function keysNotClosed(cause: unknown): AppError {
  return new AppError(
    "AGENT_GUEST_KEYS_NOT_CLOSED",
    "Гость убран, но его ключи API на сервере ещё не закрыты. Повторите удаление гостя — повтор их закроет",
    { cause },
  );
}

async function guestToolCatalog(): Promise<readonly string[]> {
  return (await import("../guests/guest-tool-surface.js")).guestToolCatalog();
}

const TOOL_DESCRIPTION = [
  "The owner's guests: people outside the family who use the agent in their own private chat, with their own separate memory, files, skills and Google, and nothing of the family's except what the owner gives them.",
  "By default a guest has every tool and built-in skill a family member has in a private chat; the owner turns some off per guest, and may give a guest skills of the family library one by one.",
  "List: {\"action\":\"list\"} returns guests (guestUserId, displayName, status, disabledTools, disabledSkills, ownSkills, grantedSkills, apiKeys with their use, skillsNeedingKeys), unused links, toolCatalog, builtInSkills and hostSkills (the library skills that can be given).",
  "Invite: {\"action\":\"invite\"} sends the owner a one-time link valid for a day; whoever opens it first becomes a guest at once, and the owner is told who joined.",
  "Configure: {\"action\":\"configure\",\"guestUserId\":\"<from list>\",\"guestDisplayName\":\"<from list>\"} with any of disabledTools, disabledSkills, grantedSkills; each list given replaces the current one, so carry its current names over and add or remove only what was asked; a list not given stays as it is.",
  "Before giving a library skill, tell the owner that the guest will see the skill's text and files and could copy them, so a skill holding the owner's personal data should not be given, and that the guest gets only the skill's files and the API keys granted to them: a skill that needs the owner's logins, tokens, installed programs or home network will not work for the guest.",
  "When skillsNeedingKeys names an API key the guest lacks, offer to grant it through the api_keys section with target=guest.",
  "Revoke: {\"action\":\"revoke\",\"guestUserId\":\"<from list>\",\"guestDisplayName\":\"<from list>\"} closes the guest's access at once, stops their API keys and pauses their reminders and scenarios; their records stay sealed and a new link to the same person brings them back with what the owner had given and turned off.",
  "Invite, configure and revoke ask for confirmation; the list does not. A guest, current or former, cannot become a family member.",
].join(" ");

export const MANAGE_GUEST_ACCESS_CALL_EXAMPLES: CallExamples = {
  list: { action: "list" },
  invite: { action: "invite" },
  configure: { action: "configure", guestUserId: "<guestUserId из list>", guestDisplayName: "Пётр", disabledTools: ["bash"], grantedSkills: ["image-gen"] },
  revoke: { action: "revoke", guestUserId: "<guestUserId из list>", guestDisplayName: "Пётр" },
};

export default withCallExamples(defineTool({
  // Invite is keyed on the call id like a family invitation; configure and revoke set a state.
  replaySafe: true,
  approval: ({ toolInput }) => {
    try {
      return parseInput(toolInput).action === "list" ? "not-applicable" : "user-approval";
    } catch (error) {
      // An invalid call goes on to execution, whose own check refuses it with an example.
      if (isAppError(error)) return "not-applicable";
      throw error;
    }
  },
  description: TOOL_DESCRIPTION,
  inputSchema: manageGuestAccessSchema,
  async execute(input, ctx) {
    const parsed = parseInput(input);
    const owner = requirePrivateTelegramOwner(ctx);
    const scope = { hostFamilyId: owner.familyId, ownerUserId: owner.userId };
    if (parsed.action === "list") {
      const listed = await guestRepository.listGuests(scope);
      return { ...listed, builtInSkills: GROUP_SAFE_SKILL_NAMES, toolCatalog: await guestToolCatalog() };
    }
    if (parsed.action === "revoke") {
      const revoked = await guestRepository.revokeGuest({ ...scope, ...parsed.target });
      // After the commit: the proxy file drops a removed guest's grants. A repeated removal publishes again.
      try {
        await apiKeyPublisher.publish();
      } catch (error) {
        throw keysNotClosed(error);
      }
      return revoked;
    }
    if (parsed.action === "configure") {
      const catalog = new Set(await guestToolCatalog());
      const unknown = (parsed.lists.disabledTools ?? []).filter((name) => !catalog.has(name));
      if (unknown.length > 0) {
        throw new AppError(
          "AGENT_GUEST_TOOL_UNKNOWN",
          `Нет таких инструментов у гостя: ${unknown.join(", ")}. Возьмите имена из toolCatalog списка гостей`,
          { details: { unknown: unknown.join(",") } },
        );
      }
      return await guestRepository.configureGuest({
        ...scope,
        ...parsed.target,
        ...parsed.lists,
        builtInSkills: new Set(GROUP_SAFE_SKILL_NAMES),
      });
    }

    const invitation = await familyRepository.createInvitation(owner.familyId, owner.userId, ctx.callId, "guest");
    if (invitation.deliveryRequired) {
      // The repository persists one transport attempt and rechecks live owner access before send.
      const delivery = { createdBy: owner.userId, familyId: owner.familyId, invitationId: invitation.invitationId, operationKey: ctx.callId };
      await familyRepository.markInvitationDeliveryStarted(delivery);
      await deliverFamilyInvitation({
        audience: "guest",
        chatId: owner.telegramChatId,
        code: invitation.code,
        expiresAt: invitation.expiresAt,
        signal: ctx.abortSignal,
      });
      await familyRepository.markInvitationDelivered(delivery);
    }
    return { delivered: true, expiresAt: invitation.expiresAt };
  },
}), MANAGE_GUEST_ACCESS_CALL_EXAMPLES);
