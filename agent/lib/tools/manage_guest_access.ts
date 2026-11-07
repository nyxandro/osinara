/**
 * The owner's guests (#471): people outside the family who use the agent in their own private chat.
 *
 * Export:
 * - `manage_guest_access` (section `guests` of `owner_settings`): list the guests, create a guest link, turn a
 *   guest's tools and skills off or back on, remove a guest.
 *
 * Key constructs:
 * - A guest link is a family invitation of kind `guest`: the same one-time code, lifetime and durable delivery
 *   to the owner's chat, never shown to the model. Whoever opens it first becomes a guest at once.
 * - Changing or removing a guest names them by `guestUserId` and `guestDisplayName` from the list, so the
 *   confirmation card shows a name and the database rechecks it.
 * - The guest tool catalog is loaded on call: the tool surface module that defines it imports the owner's door,
 *   which imports this tool.
 */
import { z } from "zod";

import { defineTool } from "../../runtime/tool.js";
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
const TOP_LEVEL_FIELDS = ["action", "guestUserId", "guestDisplayName", "disabledTools", "disabledSkills"] as const;
const NAME_LIST_MAX = 100;
const NAME_MAX_LENGTH = 64;

const manageGuestAccessSchema = z.object({
  action: z.enum(TOOL_ACTIONS).describe("Required action: list, invite, configure or revoke."),
  guestUserId: z.string().optional().describe("configure, revoke: the guest's guestUserId from list."),
  guestDisplayName: z.string().optional().describe("configure, revoke: the guest's displayName from list, copied exactly."),
  disabledTools: z.array(z.string()).optional()
    .describe("configure: the full list of tools turned off for the guest, names from toolCatalog; [] turns every tool back on."),
  disabledSkills: z.array(z.string()).optional()
    .describe("configure: the full list of skills turned off for the guest, from builtInSkills or the guest's ownSkills; [] turns every skill back on."),
}).strict();

function requireTarget(input: Record<string, unknown>) {
  return {
    guestDisplayName: requiredString(input, "guestDisplayName", INPUT_ERROR_CODE, "Пётр", { maxLength: 200 }),
    guestUserId: requiredUuid(input, "guestUserId", INPUT_ERROR_CODE, "гость из manage_guest_access с action=list"),
  };
}

function requireNames(input: Record<string, unknown>, key: "disabledSkills" | "disabledTools"): string[] {
  const value = input[key];
  if (!Array.isArray(value) || value.length > NAME_LIST_MAX ||
    value.some((name) => typeof name !== "string" || name.length === 0 || name.length > NAME_MAX_LENGTH)) {
    toolInputError(
      INPUT_ERROR_CODE,
      `Поле ${key} обязательно: полный список имён (пустой массив включает всё обратно), не больше ${NAME_LIST_MAX}. Пример: ["bash"]`,
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
  requireOnlyFields(input, ["action", "guestUserId", "guestDisplayName", "disabledTools", "disabledSkills"], "action=configure", INPUT_ERROR_CODE);
  return {
    action,
    disabledSkills: requireNames(input, "disabledSkills"),
    disabledTools: requireNames(input, "disabledTools"),
    target: requireTarget(input),
  } as const;
}

async function guestToolCatalog(): Promise<readonly string[]> {
  return (await import("../guests/guest-tool-surface.js")).guestToolCatalog();
}

const TOOL_DESCRIPTION = [
  "The owner's guests: people outside the family who use the agent in their own private chat, with their own separate memory, files, skills and Google, and nothing of the family's.",
  "By default a guest has every tool and skill a family member has in a private chat; the owner turns some off per guest.",
  "List: {\"action\":\"list\"} returns guests (guestUserId, displayName, status, disabledTools, disabledSkills, ownSkills), unused links, toolCatalog and builtInSkills.",
  "Invite: {\"action\":\"invite\"} sends the owner a one-time link valid for a day; whoever opens it first becomes a guest at once, and the owner is told who joined.",
  "Configure: {\"action\":\"configure\",\"guestUserId\":\"<from list>\",\"guestDisplayName\":\"<from list>\",\"disabledTools\":[...],\"disabledSkills\":[...]} with the full lists: carry the current ones over and add or remove only what was asked.",
  "Revoke: {\"action\":\"revoke\",\"guestUserId\":\"<from list>\",\"guestDisplayName\":\"<from list>\"} closes the guest's access at once and pauses their reminders and scenarios; their records stay sealed and a new link to the same person brings them back.",
  "Invite, configure and revoke ask for confirmation; the list does not. A guest, current or former, cannot become a family member.",
].join(" ");

export const MANAGE_GUEST_ACCESS_CALL_EXAMPLES: CallExamples = {
  list: { action: "list" },
  invite: { action: "invite" },
  configure: { action: "configure", guestUserId: "<guestUserId из list>", guestDisplayName: "Пётр", disabledTools: ["bash"], disabledSkills: [] },
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
    if (parsed.action === "revoke") return await guestRepository.revokeGuest({ ...scope, ...parsed.target });
    if (parsed.action === "configure") {
      const catalog = new Set(await guestToolCatalog());
      const unknown = parsed.disabledTools.filter((name) => !catalog.has(name));
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
        builtInSkills: new Set(GROUP_SAFE_SKILL_NAMES),
        disabledSkills: parsed.disabledSkills,
        disabledTools: parsed.disabledTools,
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
