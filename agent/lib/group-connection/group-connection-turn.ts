/**
 * A turn of a group that was disconnected while the turn was running (#465).
 *
 * Exports:
 * - `isDisconnectedGroupTurn`: whether the turn belongs to a group that is disconnected now.
 * - `logDisconnectedGroupTurnSilenced`: the expected note that such a turn's output was not delivered.
 * - `disconnectedGroupApprovalRefusal`: the refusal of a confirmation such a turn asks for.
 *
 * Its tools are already refused at the tool boundary; what it still says — the final answer, a progress
 * note, a reaction, a typing indicator or a confirmation card — is not delivered either. This is the
 * expected path; a send that slips past it is stopped and reported loudly at the Telegram transport.
 */
import { AppError } from "../app-error.js";
import { isGroupIdDisconnected } from "./group-connection-repository.js";

type TurnAuth = { current?: { attributes: Readonly<Record<string, unknown>> } | null } | undefined;

function groupIdOf(auth: TurnAuth): string | null {
  const groupId = auth?.current?.attributes.groupId;
  return typeof groupId === "string" && groupId ? groupId : null;
}

export async function isDisconnectedGroupTurn(auth: TurnAuth): Promise<boolean> {
  const groupId = groupIdOf(auth);
  return groupId !== null && await isGroupIdDisconnected(groupId);
}

export function logDisconnectedGroupTurnSilenced(input: { agentSessionId: string; agentTurnId: string; auth: TurnAuth; what: string }): void {
  console.info(JSON.stringify({
    agentSessionId: input.agentSessionId,
    agentTurnId: input.agentTurnId,
    code: "AGENT_GROUP_DISCONNECTED_TURN_SILENCED",
    groupId: groupIdOf(input.auth),
    what: input.what,
  }));
}

export function disconnectedGroupApprovalRefusal(): AppError {
  return new AppError(
    "AGENT_GROUP_DISCONNECTED",
    "Владелец отключил эту группу: подтверждения здесь не запрашиваются. Завершите ход",
    { isExpectedRefusal: true },
  );
}
