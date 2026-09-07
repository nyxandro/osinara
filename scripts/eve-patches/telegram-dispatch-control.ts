/** Application deadline fencing around the native ChannelSource, without replacing dispatch. */
import { resolve } from "node:path";

export async function patchTelegramDispatchControl(replace: (path: string, before: string, after: string) => Promise<void>) {
  const path = resolve("node_modules/eve/dist/src/public/channels/telegram/telegramChannel.js");
  await replace(path, "function telegramChannel(e={}){", `
function osinaraTelegramDispatchFrom(from,resolveSession,control){
  if(!Number.isFinite(Date.parse(control.deadlineAt))||typeof control.dispatchId!=="string"||!control.dispatchId)throw Error("AGENT_TELEGRAM_DEADLINE_INVALID");
  return token=>{
    const source=from(token);
    const prepare=options=>{
      control.signal.throwIfAborted();
      if(options.auth==null)throw Error("AGENT_TELEGRAM_DISPATCH_AUTH_MISSING");
      control.onDispatch({resolveSession:()=>resolveSession(token)});
      return {...options,auth:{...options.auth,attributes:{...options.auth.attributes,osinaraTelegramDeadlineAt:control.deadlineAt,osinaraTelegramIngressId:control.dispatchId}}};
    };
    return {...source,send:(message,options)=>source.send(message,prepare(options)),respond:(responses,options)=>source.respond(responses,prepare(options))};
  };
}
function osinaraTelegramTimeoutNotice(config,update,text,signal){
  const message=update.kind==="message"?update.message:update.callbackQuery.message;
  if(!message)throw Error("AGENT_TELEGRAM_TIMEOUT_TARGET_MISSING");
  const fetchImpl=config.api?.fetch??globalThis.fetch;
  return sendTelegramMessage({...config.api,credentials:config.credentials,chatId:message.chat.id,
    fetch:(url,init)=>{signal.throwIfAborted();return fetchImpl(url,{...init,signal})},
    body:{text,message_thread_id:message.messageThreadId,reply_parameters:{message_id:Number(message.messageId)}}});
}
function telegramChannel(e={}){`);
  await replace(path,
    "async(r,{from:a,waitUntil:o})=>{let s=await verifyInbound",
    "async(r,{from:a,resolveSession:osinaraResolveSession,waitUntil:o})=>{let s=await verifyInbound");
  // An optional data coordinate preserves Eve's event envelope while distinguishing this send
  // from automatic HITL continuations that do not advance the application's stored cursor.
  await replace(resolve("node_modules/eve/dist/src/channel/adapter.js"),
    "return withWaitingContinuationToken(i,r)}",
    "let osinaraEvent=withWaitingContinuationToken(i,r),osinaraIngressId=r.session?.auth?.current?.attributes.osinaraTelegramIngressId;return osinaraIngressId===void 0?osinaraEvent:{...osinaraEvent,data:{...osinaraEvent.data,osinaraTelegramIngressId:osinaraIngressId}}}");
  // Cancellation rolls back the unfinished step's model state, not the identity of the delivery
  // that actually entered it. Preserve both current responder and original turn author.
  await replace(resolve("node_modules/eve/dist/src/execution/workflow-steps.js"),
    "preserveSerializedSessionDynamicModelSelection(o.serializedContext,t)",
    "preserveSerializedSessionDynamicModelSelection({...o.serializedContext,...Object.fromEntries([AuthKey.name,TurnOriginAuthKey.name].filter(k=>k in t).map(k=>[k,t[k]]))},t)");
}
