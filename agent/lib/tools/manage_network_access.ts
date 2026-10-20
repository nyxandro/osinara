/**
 * Owner-approved network access management tool.
 *
 * Export:
 * - `manage_network_access`: requests, lists, or revokes sandbox access to an IP address and port.
 *
 * Key constructs:
 * - One parser validates input for both the approval policy and execution, so a forbidden
 *   destination or a non-owner is denied with its reason before the confirmation card appears.
 * - A request always waits for the owner's confirmation; listing and revoking narrow nothing open.
 * - Every change republishes the grant file the sandbox egress proxy reads on each connection.
 */
import { z } from "zod";

import { defineTool } from "../../runtime/tool.js";
import { AppError, isAppError } from "../app-error.js";
import { requirePrivateTelegramOwner } from "../family-context.js";
import { networkAccessDestinationDenial } from "../network-access/network-access-contract.js";
import { networkAccessPublisher } from "../network-access/network-access-projection.js";
import { networkAccessRepository } from "../network-access/network-access-repository.js";
import {
  requireAction,
  requiredString,
  requireInputRecord,
  requireOnlyFields,
  toolInputError,
} from "../tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_NETWORK_ACCESS_INPUT_INVALID";
const TOOL_ACTIONS = ["request", "list", "revoke"] as const;
const TOP_LEVEL_FIELDS = ["action", "address", "port", "purpose"] as const;
const PURPOSE_MAX_LENGTH = 200;

const manageNetworkAccessSchema = z.object({
  action: z.enum(TOOL_ACTIONS).describe("Required action: request, list or revoke."),
  address: z.string().optional().describe("IPv4 address, required for request and revoke, e.g. 100.91.171.16."),
  port: z.number().int().optional().describe("TCP port 1-65535, required for request and revoke, e.g. 8123."),
  purpose: z.string().optional().describe("Required for request: what this device is, shown to the owner."),
}).strict();

type NetworkAccessInput =
  | { readonly action: "list" }
  | { readonly action: "request"; readonly address: string; readonly port: number; readonly purpose: string }
  | { readonly action: "revoke"; readonly address: string; readonly port: number };

function requireDestination(input: Record<string, unknown>): { address: string; port: number } {
  const address = requiredString(input, "address", INPUT_ERROR_CODE, "100.91.171.16", { maxLength: 15 });
  const port = input.port;
  if (typeof port !== "number") {
    toolInputError(INPUT_ERROR_CODE, "Поле port обязательно и должно быть числом от 1 до 65535. Пример: 8123");
  }
  const denial = networkAccessDestinationDenial(address, port);
  if (denial === "address_invalid") {
    toolInputError(INPUT_ERROR_CODE, "Поле address должно быть IPv4-адресом без порта и имени. Пример: 100.91.171.16");
  }
  if (denial === "port_invalid") {
    toolInputError(INPUT_ERROR_CODE, "Поле port должно быть целым числом от 1 до 65535. Пример: 8123");
  }
  if (denial) {
    throw new AppError(
      "AGENT_NETWORK_ACCESS_DESTINATION_FORBIDDEN",
      "Этот адрес открыть нельзя: он принадлежит самому серверу агента или служебной сети",
      { details: { reason: denial } },
    );
  }
  return { address, port };
}

function parseNetworkAccessInput(raw: unknown): NetworkAccessInput {
  const input = requireInputRecord(raw, "manage_network_access", INPUT_ERROR_CODE);
  requireOnlyFields(input, TOP_LEVEL_FIELDS, "manage_network_access", INPUT_ERROR_CODE);
  const action = requireAction(input, "manage_network_access", TOOL_ACTIONS, INPUT_ERROR_CODE);
  // Fields another action needs may be materialized by the model; an action ignores what it does not use.
  if (action === "list") return { action };
  const destination = requireDestination(input);
  if (action === "revoke") return { action, ...destination };
  const purpose = requiredString(input, "purpose", INPUT_ERROR_CODE, "Home Assistant", {
    maxLength: PURPOSE_MAX_LENGTH,
  }).trim();
  return { action, ...destination, purpose };
}

const TOOL_DESCRIPTION = [
  "Owner-approved sandbox access to an IP address and port: home devices such as Home Assistant or a NAS, Tailscale addresses, non-standard ports.",
  "Until approved, a sandbox request to an IP fails with AGENT_SANDBOX_EGRESS_GRANT_REQUIRED.",
  "action=request (address, port, purpose) always asks the owner to confirm; list shows grants; revoke takes address and port.",
  "A grant covers bash, scripts and the browser in family sandboxes, not web_fetch.",
  "A home LAN address (192.168.x, 10.x) is usually unreachable from this server: ask the user to connect the device through a tunnel such as Tailscale and request its 100.x address.",
  "A timeout after approval means no route, not a missing grant.",
].join(" ");

export default defineTool({
  // Repeating it after a crash is safe: a grant is keyed on the call id, a revocation and a
  // republication are idempotent.
  replaySafe: true,
  approval: (ctx) => {
    try {
      const input = parseNetworkAccessInput(ctx.toolInput);
      requirePrivateTelegramOwner(ctx);
      return input.action === "request" ? "user-approval" : "not-applicable";
    } catch (error) {
      // An expected refusal reaches the model as a denied call it can explain or correct, instead of
      // ending the turn; execution repeats both checks.
      if (isAppError(error)) return { reason: error.message, type: "denied" };
      throw error;
    }
  },
  description: TOOL_DESCRIPTION,
  inputSchema: manageNetworkAccessSchema,
  async execute(raw, ctx) {
    const input = parseNetworkAccessInput(raw);
    const owner = requirePrivateTelegramOwner(ctx);

    if (input.action === "list") {
      const grants = await networkAccessRepository.listActive(owner.familyId);
      return {
        grants: grants.map(({ address, grantedAt, port, purpose }) => ({
          address, grantedAt: grantedAt.toISOString(), port, purpose,
        })),
      };
    }

    if (input.action === "revoke") {
      const revoked = await networkAccessRepository.revoke({
        address: input.address,
        familyId: owner.familyId,
        port: input.port,
        revokedBy: owner.userId,
      });
      // Published even when nothing was left to revoke: a retry after a failed publication must
      // still close the destination in the proxy.
      await networkAccessPublisher.publish();
      return { status: revoked ? "revoked" : "not_found" };
    }

    const result = await networkAccessRepository.grant({
      address: input.address,
      familyId: owner.familyId,
      grantedBy: owner.userId,
      operationKey: ctx.callId,
      port: input.port,
      purpose: input.purpose,
    });
    await networkAccessPublisher.publish();
    const status = !result.active ? "revoked_since" : result.created ? "granted" : "already_granted";
    return { address: input.address, port: input.port, status };
  },
});
