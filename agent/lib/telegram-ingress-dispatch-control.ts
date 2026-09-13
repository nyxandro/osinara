/** The verified update owns preparation, native addressing and idempotent response metadata. */
import type { TelegramDispatchControl } from "eve/channels/telegram";
import { AppError } from "./app-error.js";
import { prepareTelegramIngress, recordTelegramDispatchTarget, type TelegramPreparationContext } from "./telegram-ingress-preparation.js";

export function telegramDispatchControl(control: TelegramDispatchControl, replaying = false): TelegramDispatchControl {
  const updateId=control.updateId;
  if (!updateId) throw new AppError("AGENT_TELEGRAM_UPDATE_ID_INVALID", "Не найден проверенный источник обработки сообщения");
  const dispatchId=control.dispatchId;
  return {
    ...control,
    beforeDispatch: (token,kind) => recordTelegramDispatchTarget(updateId,dispatchId,token,kind),
    prepareCallback: (context,query,token,prepare) => {
      const verified: TelegramPreparationContext={ ...context,ingressRecovery: { updateId,dispatchId,...(replaying ? { replaying: true } : {}) } };
      return prepare(verified,query,token);
    },
    prepareMessage: (context,message,prepare) => prepareTelegramIngress({ updateId,dispatchId,context,message,
      prepare: async (ctx,msg) => prepare(ctx,msg) }),
  };
}
