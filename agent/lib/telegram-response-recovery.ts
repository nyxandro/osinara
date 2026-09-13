/** Replay only a native-deduplicated response to its fixed session, then observe its original execution. */
import type { TelegramDrainContext, TelegramUpdate } from "eve/channels/telegram";
import type { TelegramIngressClaim, TelegramIngressRepository } from "./telegram-ingress-contract.js";
import { readConfiguredEveRunStatus } from "./sessions/workflow-postgres-session-storage.js";
import { runTelegramProcessing, TelegramProcessingTimeout } from "./telegram-processing-deadline.js";
import { telegramDispatchControl } from "./telegram-ingress-dispatch-control.js";
import { AppError } from "./app-error.js";

export async function resumeTelegramResponse(input: {
  claim: TelegramIngressClaim;
  update: TelegramUpdate;
  dispatch: TelegramDrainContext["dispatch"];
  repository: Pick<TelegramIngressRepository,"complete" | "release" | "sessionEventStreamCursor">;
  signal: AbortSignal;
  admissionMilliseconds: number;
  cancellationMilliseconds: number;
}): Promise<boolean> {
  const { claim }=input;
  const binding=claim.dispatchBinding;
  const dispatchId=claim.dispatchAttemptId;
  if (!dispatchId) throw new AppError("AGENT_TELEGRAM_DISPATCH_ID_INVALID", "Не найдена сохранённая попытка обработки подтверждения");
  if (binding) {
    const status=await readConfiguredEveRunStatus(binding.sessionId);
    if (status === "completed" || status === "failed" || status === "cancelled") return false;
  }
  const session=await runTelegramProcessing({ dispatchId,updateId: claim.updateId,signal: input.signal,
    timeoutMilliseconds: input.admissionMilliseconds,cancellationMilliseconds: input.cancellationMilliseconds,
    readCursor: id => input.repository.sessionEventStreamCursor(id),
    execute: async control => {
      const resumed=await input.dispatch(input.update,telegramDispatchControl(control,true));
      if (binding && resumed && resumed.id !== binding.sessionId) throw new TelegramProcessingTimeout(binding.sessionId,true);
      return resumed;
    },
  });
  if (binding) return false;
  if (!session) await input.repository.complete(claim.updateId,claim.leaseToken);
  else await input.repository.release(claim.updateId,claim.leaseToken,{
    code: "AGENT_TELEGRAM_CALLBACK_RECOVERED",message: "Решение повторно передано с защитой от двойного исполнения",
  });
  return true;
}
