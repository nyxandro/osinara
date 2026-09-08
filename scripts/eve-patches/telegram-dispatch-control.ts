/** Application deadline fencing around the native ChannelSource, without replacing dispatch. */
import { resolve } from "node:path";

export async function patchTelegramDispatchControl(replace: (path: string, before: string, after: string) => Promise<void>) {
  // Eve retains the last principal/auth when coalescing deliveries. Only this application-owned
  // receipt metadata is unioned, so every consumed timeout handoff reaches its waiting boundary.
  await replace(resolve("node_modules/eve/dist/src/harness/messages.js"),
    "function coalesceDeliveries(e){",
    `function coalesceDeliveries(items){
      const result=osinaraBaseCoalesceDeliveries(items);
      const ids=items.flatMap(item=>{
        const value=item.auth?.attributes?.osinaraRuntimeHandoffIds;
        if(value===undefined)return [];
        if(!Array.isArray(value)||value.some(id=>typeof id!=="string"||!id))throw Error("AGENT_RUNTIME_HANDOFF_INVALID");
        return value;
      });
      if(ids.length===0||result.auth==null)return result;
      return {...result,auth:{...result.auth,attributes:{...result.auth.attributes,osinaraRuntimeHandoffIds:[...new Set(ids)]}}};
    }
    function osinaraBaseCoalesceDeliveries(e){`);
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
      return {...options,auth:{...options.auth,attributes:{...options.auth.attributes,osinaraTelegramDeadlineAt:control.deadlineAt,osinaraTelegramIngressId:control.dispatchId,...control.updateId===undefined?{}:{osinaraTelegramUpdateId:control.updateId}}}};
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
    "async(r,{from:a,attachSession:osinaraAttachSession,resolveSession:osinaraResolveSession,waitUntil:o})=>{let s=await verifyInbound");
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
