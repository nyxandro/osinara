/** Checkpoint inbound preparation and fence every pre-model Telegram effect by the original update. */
import { createHash } from "node:crypto";
import type { TelegramContext, TelegramInboundResult, TelegramMessage } from "eve/channels/telegram";
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { telegramRepository } from "./telegram-repository.js";
import { evaluateConversationAccess } from "./family-access.js";
import { telegramInboundActor } from "./telegram-inbound-actor.js";

export interface TelegramPreparationContext extends TelegramContext {
  readonly ingressRecovery?: { readonly updateId: string; readonly dispatchId: string; readonly replaying?: boolean };
}

async function verifyStoredAuthorization(message: TelegramMessage, result: TelegramInboundResult): Promise<void> {
  if (result === null) return;
  const actor = telegramInboundActor(message);
  const auth = result.auth;
  if (!actor || !auth || message.chat.type === "channel") throw new AppError("AGENT_TELEGRAM_PREPARATION_INVALID", "Не удалось проверить сохранённый запрос");
  const identity = actor.kind === "telegram_user" ? await telegramRepository.findIdentity(actor.id) : null;
  const group = message.chat.type === "group" || message.chat.type === "supergroup"
    ? await telegramRepository.findGroup(message.chat.id, message.chat.type) : null;
  const decision = evaluateConversationAccess({ actorKind: actor.kind, chat: { id: message.chat.id, type: message.chat.type }, identity, registeredGroup: group });
  if (!decision.allowed || decision.access.familyId !== auth.attributes.familyId || decision.access.role !== auth.attributes.role ||
      (decision.access.groupId ?? null) !== (auth.attributes.groupId ?? null) ||
      (group?.type ?? null) !== (auth.attributes.groupType ?? null) || auth.attributes.telegramChatId !== message.chat.id ||
      JSON.stringify(decision.access.memoryScopes) !== JSON.stringify(auth.attributes.memoryScopes) ||
      (group?.messageMode === "owner_only" && identity?.role !== "owner") ||
      (group?.type === "external" && JSON.stringify(group.toolAllowlist) !== JSON.stringify(auth.attributes.toolAllowlist))) {
    throw new AppError("AGENT_TELEGRAM_PREPARATION_ACCESS_CHANGED", "Права доступа изменились во время восстановления запроса");
  }
  const session = await database().query(`SELECT 1 FROM conversation_sessions WHERE id=$1 AND retired_at IS NULL`, [auth.attributes.applicationSessionId]);
  if (session.rowCount !== 1) throw new AppError("AGENT_TELEGRAM_PREPARATION_SESSION_RETIRED", "Контекст прерванного запроса уже закрыт");
}

export async function prepareTelegramIngress(input: {
  updateId: string; dispatchId: string; context: TelegramContext; message: TelegramMessage;
  prepare(context: TelegramPreparationContext, message: TelegramMessage): Promise<TelegramInboundResult>;
}): Promise<TelegramInboundResult> {
  const current = await database().query<{ preparation_completed_at: Date | null; preparation_result: TelegramInboundResult }>(
    `SELECT preparation_completed_at,preparation_result FROM telegram_ingress_updates
      WHERE update_id=$1 AND dispatch_id=$2 AND status='processing' AND lease_expires_at>now()`, [input.updateId, input.dispatchId]);
  const row = current.rows[0];
  if (!row) throw new AppError("AGENT_TELEGRAM_LEASE_LOST", "Попытка подготовки сообщения уже закрыта");
  if (row.preparation_completed_at !== null) {
    await verifyStoredAuthorization(input.message, row.preparation_result);
    return row.preparation_result;
  }
  let ordinal = 0;
  const methods = new Set(["sendMessage", "request", "answerCallbackQuery"]);
  const telegram = new Proxy(input.context.telegram, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || !methods.has(property) || typeof value !== "function") return value;
      return (...args: unknown[]) => preparationEffect(input.updateId, input.dispatchId, ordinal++, property, args,
        () => Reflect.apply(value, target, args));
    },
  });
  let result = await input.prepare({ ...input.context, telegram,
    ingressRecovery: { updateId: input.updateId, dispatchId: input.dispatchId } }, input.message);
  const response = (await database().query<{ response_session_id: string | null }>(
    "SELECT response_session_id FROM telegram_ingress_updates WHERE update_id=$1 AND dispatch_id=$2", [input.updateId,input.dispatchId])).rows[0];
  if (response?.response_session_id && result?.auth) result = { ...result,auth: { ...result.auth,
    attributes: { ...result.auth.attributes,osinaraTelegramResponseSessionId: response.response_session_id } } };
  const saved = await database().query(`UPDATE telegram_ingress_updates SET preparation_result=$3::jsonb,
    preparation_completed_at=now() WHERE update_id=$1 AND dispatch_id=$2 AND status='processing' AND lease_expires_at>now()`,
  [input.updateId, input.dispatchId, JSON.stringify(result)]);
  if (saved.rowCount !== 1) throw new AppError("AGENT_TELEGRAM_LEASE_LOST", "Попытка подготовки сообщения уже закрыта");
  return result;
}

async function preparationEffect(updateId: string, dispatchId: string, ordinal: number, method: string, args: unknown[], execute: () => Promise<unknown>): Promise<unknown> {
  const hash = createHash("sha256").update(JSON.stringify([method, args])).digest("hex");
  const claimed = await database().query(`INSERT INTO telegram_preparation_effects(update_id,ordinal,input_hash,status)
    SELECT update_id,$3,$4,'started' FROM telegram_ingress_updates WHERE update_id=$1 AND dispatch_id=$2
      AND status='processing' AND lease_expires_at>now() ON CONFLICT DO NOTHING RETURNING update_id`, [updateId, dispatchId, ordinal, hash]);
  if (claimed.rowCount !== 1) {
    const existing = await database().query<{ input_hash: string; status: string; result: { value?: unknown } }>(
      "SELECT input_hash,status,result FROM telegram_preparation_effects WHERE update_id=$1 AND ordinal=$2", [updateId, ordinal]);
    const row = existing.rows[0];
    if (!row || row.input_hash !== hash || row.status !== "completed") throw new AppError(
      "AGENT_TELEGRAM_PREPARATION_EFFECT_UNCONFIRMED", "Результат служебного действия не подтверждён. Повторная отправка остановлена");
    return row.result.value;
  }
  const value = await execute();
  await database().query(`UPDATE telegram_preparation_effects SET status='completed',result=$3::jsonb WHERE update_id=$1 AND ordinal=$2`,
    [updateId, ordinal, JSON.stringify(value === undefined ? {} : { value })]);
  return value;
}

export async function recordTelegramDispatchTarget(updateId: string, dispatchId: string, continuationToken: string, kind: "send" | "respond"): Promise<void> {
  const result = await database().query(`UPDATE telegram_ingress_updates SET dispatch_continuation_key=$3,dispatch_kind=$4
    WHERE update_id=$1 AND dispatch_id=$2 AND status='processing' AND lease_expires_at>now()`, [updateId, dispatchId, continuationToken, kind]);
  if (result.rowCount !== 1) throw new AppError("AGENT_TELEGRAM_LEASE_LOST", "Попытка передачи сообщения уже закрыта");
}
