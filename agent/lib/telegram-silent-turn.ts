/**
 * Observability for a Telegram turn the model deliberately finished without a message.
 *
 * Exports:
 * - `telegramSilentTurnLogRecord`: structured record built from verified auth attributes only.
 * - `logTelegramSilentTurn`: writes that record at the channel boundary.
 *
 * Key construct:
 * - Silence is a normal outcome in a group, so the record is informational. It carries the chat
 *   type, the group type and the technical trigger of the turn, which is what shows whether the
 *   model keeps quiet for the right reasons. Participant text and Telegram identifiers stay out.
 */
const SILENT_TURN_CODE = "AGENT_TELEGRAM_SILENT_TURN";

export interface TelegramSilentTurnLogInput {
  auth: { readonly attributes: Readonly<Record<string, unknown>> } | null | undefined;
  agentSessionId: string;
  agentTurnId: string;
}

export interface TelegramSilentTurnLogRecord {
  chatType?: string;
  code: typeof SILENT_TURN_CODE;
  agentSessionId: string;
  agentTurnId: string;
  groupType?: string;
  triggeredBy?: string;
}

function stringAttribute(
  attributes: Readonly<Record<string, unknown>> | undefined,
  name: string,
): string | undefined {
  const value = attributes?.[name];
  return typeof value === "string" ? value : undefined;
}

export function telegramSilentTurnLogRecord(
  input: TelegramSilentTurnLogInput,
): TelegramSilentTurnLogRecord {
  const attributes = input.auth?.attributes;
  const chatType = stringAttribute(attributes, "telegramChatType");
  const groupType = stringAttribute(attributes, "groupType");
  const triggeredBy = stringAttribute(attributes, "telegramGroupTurnTrigger");
  return {
    code: SILENT_TURN_CODE,
    ...(chatType === undefined ? {} : { chatType }),
    agentSessionId: input.agentSessionId,
    agentTurnId: input.agentTurnId,
    ...(groupType === undefined ? {} : { groupType }),
    ...(triggeredBy === undefined ? {} : { triggeredBy }),
  };
}

export function logTelegramSilentTurn(input: TelegramSilentTurnLogInput): void {
  console.info(JSON.stringify(telegramSilentTurnLogRecord(input)));
}
