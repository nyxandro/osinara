/**
 * Reproducible local Eve 0.40.0 patch installer.
 *
 * Constructs:
 * - `replaceExact`: fail-fast, count-checked, idempotent artifact replacement.
 * - Production startup health wait: permits bounded first-run sandbox preparation.
 * - Workflow transport: bounded internal HTTP and a process-local fence for live redelivery.
 * - Review delegation policy: keeps implicit root delegation out of background memory review.
 * - Mandatory adapter preparation: propagates failed `turn.started` and `input.requested` handlers.
 * - Background task auth: restores the verified caller that created the task on every parent wake.
 * - Telegram durable ingress: verified-update and authenticated internal-drain hooks.
 * - Telegram dispatch extensions: Session return, message/token override, reply routing, and HITL auth.
 * - Telegram topic normalization: accepts thread IDs only on explicit forum-topic updates.
 * - Telegram public types: exposes only the reviewed application seams.
 * - Dynamic instructions: previews the current message before it is appended to durable history.
 * - Skills/HITL: bulk materialization and single-pass context-only approval continuations.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { patchWorkflowTransport } from "./eve-patches/workflow-transport.ts";
import { patchSkillSync } from "./eve-patches/skill-sync.ts";
import { patchHitlContext } from "./eve-patches/hitl-context.ts";
import { patchStreamRecovery } from "./eve-patches/stream-recovery.ts";
import { patchTelegramDispatchControl } from "./eve-patches/telegram-dispatch-control.ts";
import { patchModelInactivity } from "./eve-patches/model-inactivity.ts";

const EXPECTED_EVE_VERSION = "0.40.0";
const EVE_PRODUCTION_START_HEALTH_TIMEOUT_MS = 300_000;

const runtimePaths = {
  approvalDelivery: resolve("node_modules/eve/dist/src/harness/approval-delivery-coordinator.js"),
  channelAdapter: resolve("node_modules/eve/dist/src/channel/adapter.js"),
  channelAdapterTypes: resolve("node_modules/eve/dist/src/channel/adapter.d.ts"),
  compaction: resolve("node_modules/eve/dist/src/harness/compaction.js"),
  contextKeys: resolve("node_modules/eve/dist/src/context/keys.js"),
  contextKeyTypes: resolve("node_modules/eve/dist/src/context/keys.d.ts"),
  dispatchRuntimeActionsShared: resolve(
    "node_modules/eve/dist/src/execution/dispatch-runtime-actions-shared.js",
  ),
  dispatchRuntimeActionsSharedTypes: resolve(
    "node_modules/eve/dist/src/execution/dispatch-runtime-actions-shared.d.ts",
  ),
  productionStart: resolve(
    "node_modules/eve/dist/src/internal/nitro/host/start-production-server.js",
  ),
  telegram: resolve(
    "node_modules/eve/dist/src/public/channels/telegram/telegramChannel.js",
  ),
  telegramInbound: resolve("node_modules/eve/dist/src/public/channels/telegram/inbound.js"),
  telegramIndexTypes: resolve(
    "node_modules/eve/dist/src/public/channels/telegram/index.d.ts",
  ),
  telegramTypes: resolve(
    "node_modules/eve/dist/src/public/channels/telegram/telegramChannel.d.ts",
  ),
  taskChildSteps: resolve(
    "node_modules/eve/dist/src/execution/tasks/child/steps.js",
  ),
  taskChildStepTypes: resolve(
    "node_modules/eve/dist/src/execution/tasks/child/steps.d.ts",
  ),
  taskChildWorkflow: resolve(
    "node_modules/eve/dist/src/execution/tasks/child/workflow.js",
  ),
  taskChildWorkflowTypes: resolve(
    "node_modules/eve/dist/src/execution/tasks/child/workflow.d.ts",
  ),
  taskDispatch: resolve(
    "node_modules/eve/dist/src/execution/tasks/parent/dispatch-task-step.js",
  ),
  taskParentDelegate: resolve(
    "node_modules/eve/dist/src/execution/tasks/parent/delegate.js",
  ),
  taskParentDelegateTypes: resolve(
    "node_modules/eve/dist/src/execution/tasks/parent/delegate.d.ts",
  ),
  toolLoop: resolve("node_modules/eve/dist/src/harness/tool-loop.js"),
  workflowSteps: resolve("node_modules/eve/dist/src/execution/workflow-steps.js"),
} as const;

function occurrenceCount(source: string, marker: string): number {
  if (marker.length === 0) {
    throw new Error("AGENT_EVE_PATCH_MARKER_EMPTY: Eve patch marker cannot be empty");
  }
  return source.split(marker).length - 1;
}

async function replaceExact(
  path: string,
  before: string,
  after: string,
  expectedCount = 1,
): Promise<void> {
  const source = await readFile(path, "utf8");
  const beforeCount = occurrenceCount(source, before);
  const afterCount = occurrenceCount(source, after);
  const embeddedBeforeCount = occurrenceCount(after, before);
  const unpatchedBeforeCount = beforeCount - afterCount * embeddedBeforeCount;

  // A fully patched artifact is accepted unchanged; every partial or unknown state fails closed.
  if (unpatchedBeforeCount === 0 && afterCount === expectedCount) return;
  if (unpatchedBeforeCount !== expectedCount || afterCount !== 0) {
    throw new Error(
      `AGENT_EVE_PATCH_MISMATCH: Не удалось применить проверенный Eve 0.40.0 patch к ${path}; before=${beforeCount}, after=${afterCount}, expected=${expectedCount}`,
    );
  }

  await writeFile(path, source.split(before).join(after), "utf8");
}

// The package version gates every minified replacement against the exact reviewed release.
const evePackage = JSON.parse(
  await readFile(resolve("node_modules/eve/package.json"), "utf8"),
) as { version?: string };
if (evePackage.version !== EXPECTED_EVE_VERSION) {
  throw new Error(
    `AGENT_EVE_PATCH_VERSION_UNSUPPORTED: Ожидалась Eve ${EXPECTED_EVE_VERSION}, установлена ${String(evePackage.version)}`,
  );
}

await patchWorkflowTransport(replaceExact);
await patchSkillSync(replaceExact);
await patchHitlContext(replaceExact);
await patchStreamRecovery(replaceExact);
await patchTelegramDispatchControl(replaceExact);
await patchModelInactivity(replaceExact);

// A cold production start may prepare sandbox images before the child server becomes healthy.
await replaceExact(
  runtimePaths.productionStart,
  "const HEALTH_TIMEOUT_MS=6e4",
  `const HEALTH_TIMEOUT_MS=${EVE_PRODUCTION_START_HEALTH_TIMEOUT_MS.toExponential().replace("+", "")}`,
);

// Eve owns model-call recovery. Its own classifier retries only transport-shaped failures (408,
// 409, 429, 5xx, explicitly retryable and catalog-transient errors) and never an invalid request
// or a configuration error, and the retry wraps one model call: tool calls run after that call
// returns, so a reissue repeats no side effect. AI SDK retries cover a connection that never
// established; only this outer layer can recover a stream that broke after the response started.

// Internal background review must not inherit root delegation. Match the
// complete implicit-agent fingerprint so authored tools and declared subagents remain untouched.
await replaceExact(
  runtimePaths.toolLoop,
  "function buildHarnessToolsWithDynamicSubagents(e,t){let n=new Map(e);if(t===void 0)return n;",
  "function buildHarnessToolsWithDynamicSubagents(e,t){let n=new Map(e);if(t===void 0)return n;let r=t.get(AuthKey),i=n.get(`agent`),a=r?.authenticator===`memory-review`&&r.attributes.memoryReviewMode===`background`;a&&i?.runtimeAction?.kind===`subagent-call`&&i.runtimeAction.nodeId===`__root__`&&i.runtimeAction.subagentName===`agent`&&n.delete(`agent`);",
);

// Eve 0.40.0 emits turn.started before appending I.message/I.context to history. Its public
// instruction resolver otherwise sees only the previous turn, breaking current-message retrieval
// after a plain-text reply or compaction and silently searching by an old question on other turns.
// Preview only: the native history append below the preamble remains the sole persisted copy.
await replaceExact(
  runtimePaths.toolLoop,
  "function buildHarnessToolsWithDynamicSubagents(e,t){",
  "function osinaraInstructionTurnMessages(e,t){let n=normalizeUserContent(t?.message);return n===void 0?e:[...e,...(t?.context??[]).map(e=>({content:e,role:`user`})),{content:n,role:`user`}]}function buildHarnessToolsWithDynamicSubagents(e,t){",
);
await replaceExact(
  runtimePaths.toolLoop,
  "prepareDynamicInstructionPreamble(k,B.session.history)",
  "prepareDynamicInstructionPreamble(k,osinaraInstructionTurnMessages(B.session.history,I))",
);
await replaceExact(
  runtimePaths.toolLoop,
  "prepareDynamicInstructionPreamble(k,e.history)",
  "prepareDynamicInstructionPreamble(k,osinaraInstructionTurnMessages(e.history,I))",
);

// A partial answer to a multi-request HITL batch is durably deferred without a new turn. Report
// that it is still waiting, otherwise FIFO cannot reach the next button needed to finish the batch.
// Do not complete a turn or duplicate the epilogue already emitted after resolved runtime actions.
await replaceExact(
  runtimePaths.toolLoop,
  "if(B.outcome===`unresolved`){let e=",
  "if(B.outcome===`unresolved`){if(M&&t.mode===`conversation`&&(I?.inputResponses?.length??0)>0&&P.outcome!==`resolved`)await M(createSessionWaitingEvent());let e=",
);

// On a second direct decision Eve removes the already-settled first response from k. Its early
// return must put h back, as the normal return below does, or a multi-request batch never completes.
await replaceExact(
  runtimePaths.approvalDelivery,
  "if(E)return deliveryResult(d,k,`continue`,[],w);",
  "if(E)return deliveryResult(d,appendSettledResponses(k,h),`continue`,[],w);",
);

// Compaction may shrink the local recent window, but it may not buy another summary model call.
await replaceExact(
  runtimePaths.compaction,
  "if(evaluateThreshold(v,i,`estimate`).type===`within-limit`||m===0)return v;--m",
  "if(evaluateThreshold(v,i,`estimate`).type===`within-limit`)return v;throw Error(`EVE_COMPACTION_OUTPUT_TOO_LARGE: Compaction result exceeds the configured threshold`)",
);

// Failure to persist an approval prompt must fail the turn instead of parking it unbound.
await replaceExact(
  runtimePaths.channelAdapter,
  "catch(r){log.error(`adapter event handler threw — event swallowed`,{adapterKind:getAdapterKind(e),eventType:n.type,error:r})}",
  "catch(r){log.error(`adapter event handler threw`,{adapterKind:getAdapterKind(e),eventType:n.type,error:r});if(n.type===`input.requested`||n.type===`turn.started`)throw r}",
);
await replaceExact(
  runtimePaths.channelAdapterTypes,
  " * Throwing handlers are logged and swallowed so a downstream delivery\n * failure does not corrupt the event stream write path.",
  " * Required `turn.started` preparation and `input.requested` persistence failures\n * propagate. Optional notification handler failures remain logged and swallowed.",
);

// Framework task wakes are ordinary deliveries. Without an explicit caller they reuse whichever
// request most recently touched the parent session, which may be an HITL callback or another user.
// Freeze the caller at the originating turn and send it on every durable task-owned wake. The
// optional task-run field keeps old in-flight runs readable; absence becomes null and fails closed.
await replaceExact(
  runtimePaths.contextKeys,
  "ChannelDeliveryKey=new ContextKey(`eve.channelDelivery`),TurnTaskDeliveryKey=new ContextKey(`eve.turnTaskDelivery`)",
  "ChannelDeliveryKey=new ContextKey(`eve.channelDelivery`),TurnOriginAuthKey=new ContextKey(`eve.turnOriginAuth`),TurnTaskDeliveryKey=new ContextKey(`eve.turnTaskDelivery`)",
);
await replaceExact(
  runtimePaths.contextKeys,
  "TurnDynamicToolMetadataKey,TurnTaskDeliveryKey",
  "TurnDynamicToolMetadataKey,TurnOriginAuthKey,TurnTaskDeliveryKey",
);
await replaceExact(
  runtimePaths.contextKeyTypes,
  "export declare const ChannelDeliveryKey: ContextKey<ChannelDeliveryMetadata>;\n/** Whether the active turn began from a task-addressed durable delivery. */",
  "export declare const ChannelDeliveryKey: ContextKey<ChannelDeliveryMetadata>;\n/** Verified caller delivered at the start of the active turn. */\nexport declare const TurnOriginAuthKey: ContextKey<SessionAuthContext | null>;\n/** Whether the active turn began from a task-addressed durable delivery. */",
);
await replaceExact(
  runtimePaths.workflowSteps,
  "AuthKey,CapabilitiesKey,ModeKey,SessionDynamicSubagentRuntimeRevisionKey,SessionDynamicToolRuntimeRevisionKey,TurnTaskDeliveryKey",
  "AuthKey,CapabilitiesKey,ModeKey,SessionDynamicSubagentRuntimeRevisionKey,SessionDynamicToolRuntimeRevisionKey,TurnOriginAuthKey,TurnTaskDeliveryKey",
);
await replaceExact(
  runtimePaths.workflowSteps,
  "a.input?.kind===`deliver`&&c.set(TurnTaskDeliveryKey,a.input.taskDeliveryId!==void 0)",
  "a.input?.kind===`deliver`&&(c.set(TurnTaskDeliveryKey,a.input.taskDeliveryId!==void 0),getHarnessEmissionState(s.state).turnId.length===0&&c.set(TurnOriginAuthKey,a.input.auth??null))",
);
await replaceExact(
  runtimePaths.dispatchRuntimeActionsShared,
  "AuthKey,CapabilitiesKey,ChannelInstrumentationKey,InitiatorAuthKey,SandboxKey",
  "AuthKey,CapabilitiesKey,ChannelInstrumentationKey,InitiatorAuthKey,SandboxKey,TurnOriginAuthKey",
);
await replaceExact(
  runtimePaths.dispatchRuntimeActionsShared,
  "serializedContext:e.serializedContext,session:u}",
  "serializedContext:e.serializedContext,session:u,turnOriginAuth:s.get(TurnOriginAuthKey)}",
);
await replaceExact(
  runtimePaths.dispatchRuntimeActionsSharedTypes,
  "    readonly session: RuntimeSession;\n}",
  "    readonly session: RuntimeSession;\n    readonly turnOriginAuth: Parameters<typeof buildSubagentRunInput>[0][\"auth\"] | undefined;\n}",
);
await replaceExact(
  runtimePaths.taskDispatch,
  "let n=await beginDelegatedTask({",
  "let n=await beginDelegatedTask({auth:i.turnOriginAuth??null,",
);
await replaceExact(
  runtimePaths.taskParentDelegate,
  "initialView:{metadata:o,status:`working`,taskId:r},parentContinuationToken:sessionCommandHookToken(n.session.sessionId)",
  "initialView:{metadata:o,status:`working`,taskId:r},parentAuth:n.auth,parentContinuationToken:sessionCommandHookToken(n.session.sessionId)",
);
await replaceExact(
  runtimePaths.taskParentDelegateTypes,
  "import type { JsonValue } from \"#shared/json.js\";",
  "import type { JsonValue } from \"#shared/json.js\";\nimport type { SessionAuthContext } from \"#channel/types.js\";",
);
await replaceExact(
  runtimePaths.taskParentDelegateTypes,
  "export declare function beginDelegatedTask(input: {\n    readonly agentId: string;",
  "export declare function beginDelegatedTask(input: {\n    readonly auth: SessionAuthContext | null;\n    readonly agentId: string;",
);
await replaceExact(
  runtimePaths.taskChildWorkflowTypes,
  "import { type TaskView } from \"#tasks/types.js\";",
  "import type { SessionAuthContext } from \"#channel/types.js\";\nimport { type TaskView } from \"#tasks/types.js\";",
);
await replaceExact(
  runtimePaths.taskChildWorkflowTypes,
  "    readonly parentContinuationToken: string;\n}",
  "    readonly parentContinuationToken: string;\n    /** Additive for old in-flight task runs; absence is restored as fail-closed null auth. */\n    readonly parentAuth?: SessionAuthContext | null;\n}",
);
await replaceExact(
  runtimePaths.taskChildWorkflow,
  "let a=createHook({token:i.taskInboxToken}),o=a[Symbol.asyncIterator](),s=!1;",
  "let a=createHook({token:i.taskInboxToken}),o=a[Symbol.asyncIterator](),s=!1,y=i.parentAuth??null;",
);
await replaceExact(
  runtimePaths.taskChildWorkflow,
  "wakeTaskUpdateParentStep({token:i.parentContinuationToken,",
  "wakeTaskUpdateParentStep({auth:y,token:i.parentContinuationToken,",
  3,
);
await replaceExact(
  runtimePaths.taskChildWorkflow,
  "wakeTaskParentStep({token:i.parentContinuationToken,",
  "wakeTaskParentStep({auth:y,token:i.parentContinuationToken,",
  2,
);
await replaceExact(
  runtimePaths.taskChildWorkflow,
  "wakeTaskAuthorizationParentStep({request:",
  "wakeTaskAuthorizationParentStep({auth:y,request:",
);
await replaceExact(
  runtimePaths.taskChildWorkflow,
  "wakeTaskInputRequestParentStep({request:",
  "wakeTaskInputRequestParentStep({auth:y,request:",
);
await replaceExact(
  runtimePaths.taskChildSteps,
  "let a={kind:`send`,payload:i,taskDeliveryId:",
  "let a={auth:e.auth,kind:`send`,payload:i,taskDeliveryId:",
);
await replaceExact(
  runtimePaths.taskChildSteps,
  "let r={kind:`send`,payload:n,taskDeliveryId:",
  "let r={auth:e.auth,kind:`send`,payload:n,taskDeliveryId:",
);
await replaceExact(
  runtimePaths.taskChildSteps,
  "let n={kind:`send`,payload:{message:`Background task",
  "let n={auth:e.auth,kind:`send`,payload:{message:`Background task",
);
await replaceExact(
  runtimePaths.taskChildSteps,
  "let n={kind:`send`,payload:{task:{inputRequests:",
  "let n={auth:e.auth,kind:`send`,payload:{task:{inputRequests:",
);
await replaceExact(
  runtimePaths.taskChildStepTypes,
  "export declare function wakeTaskAuthorizationParentStep(input: {\n    readonly request:",
  "export declare function wakeTaskAuthorizationParentStep(input: {\n    readonly auth: import(\"#channel/types.js\").SessionAuthContext | null;\n    readonly request:",
);
await replaceExact(
  runtimePaths.taskChildStepTypes,
  "export declare function wakeTaskParentStep(input: {\n    readonly token:",
  "export declare function wakeTaskParentStep(input: {\n    readonly auth: import(\"#channel/types.js\").SessionAuthContext | null;\n    readonly token:",
);
await replaceExact(
  runtimePaths.taskChildStepTypes,
  "export declare function wakeTaskUpdateParentStep(input: {\n    readonly token:",
  "export declare function wakeTaskUpdateParentStep(input: {\n    readonly auth: import(\"#channel/types.js\").SessionAuthContext | null;\n    readonly token:",
);
await replaceExact(
  runtimePaths.taskChildStepTypes,
  "export declare function wakeTaskInputRequestParentStep(input: {\n    readonly request:",
  "export declare function wakeTaskInputRequestParentStep(input: {\n    readonly auth: import(\"#channel/types.js\").SessionAuthContext | null;\n    readonly request:",
);

// Verified webhooks can be durably acknowledged before native dispatch; drain reuses that dispatcher.
await replaceExact(
  runtimePaths.telegram,
  "let u=parseTelegramUpdate(c);return u===null?new Response(`ok`):u.kind===`message`?(o(dispatchMessage({config:e,message:u.message,onMessage:n,uploadPolicy:t,from:a})),new Response(`ok`)):(o(dispatchCallbackQuery({config:e,query:u.callbackQuery,from:a})),new Response(`ok`))",
  "let u=parseTelegramUpdate(c);if(u===null)return new Response(`ok`);let d=(l,g)=>{g?.signal.throwIfAborted();let f=g?osinaraTelegramDispatchFrom(a,osinaraResolveSession,g):a;return l.kind===`message`?dispatchMessage({config:e,message:l.message,onMessage:n,uploadPolicy:t,from:f}):dispatchCallbackQuery({config:e,query:l.callbackQuery,from:f})};return e.onVerifiedUpdate!==void 0?e.onVerifiedUpdate({attachSession:osinaraAttachSession,dispatch:d,notifyTimeout:(u,t,s)=>osinaraTelegramTimeoutNotice(e,u,t,s),raw:c,update:u,waitUntil:o}):(o(d(u)),new Response(`ok`))",
);
await replaceExact(
  runtimePaths.telegram,
  "})],async receive",
  "}),...e.onDrain===void 0?[]:[POST(e.drainRoute??`/eve/v1/telegram-drain`,async(r,{from:a,attachSession:osinaraAttachSession,resolveSession:osinaraResolveSession,waitUntil:o})=>{if(await verifyInbound(r,e.credentials)===null)return new Response(`unauthorized`,{status:401});let d=(l,g)=>{g?.signal.throwIfAborted();let f=g?osinaraTelegramDispatchFrom(a,osinaraResolveSession,g):a;return l.kind===`message`?dispatchMessage({config:e,message:l.message,onMessage:n,uploadPolicy:t,from:f}):dispatchCallbackQuery({config:e,query:l.callbackQuery,from:f})};return e.onDrain({attachSession:osinaraAttachSession,dispatch:d,notifyTimeout:(u,t,s)=>osinaraTelegramTimeoutNotice(e,u,t,s),waitUntil:o})})]],async receive",
);

// Bot API 10.0 lets a bot see other bots' group messages, but Eve still drops every bot sender
// before `onMessage` runs. Application authorization decides which chat may admit a bot; the
// channel must not make that decision for it.
await replaceExact(
  runtimePaths.telegram,
  "async function dispatchMessage(e){if(e.message.from?.isBot===!0)return;let t=stateFromMessage(e.message,e.config)",
  "async function dispatchMessage(e){let t=stateFromMessage(e.message,e.config)",
);

// Authorized application output controls only the model-visible message and continuation address.
await replaceExact(
  runtimePaths.telegram,
  "catch(e){log.error(`message handler failed`,{error:e});return}if(r==null)return",
  "catch(e){log.error(`message handler failed`,{error:e});throw e}if(r==null)return",
);
await replaceExact(
  runtimePaths.telegram,
  "u=e.message.replyToMessage?.from?.isBot===!0&&l.trim().length>0?",
  "u=r.replyHandling!==`message`&&e.message.replyToMessage?.from?.isBot===!0&&l.trim().length>0?",
);
await replaceExact(
  runtimePaths.telegram,
  "let n=e.from(continuationTokenFromState(t));u===void 0?await n.send(a,{auth:r.auth,context:[o,...s],state:t,title:r.title}):await n.respond(u,{auth:r.auth,context:[o,...s]})",
  "let n=e.from(r.continuationToken??continuationTokenFromState(t));return u===void 0?await n.send(r.message??a,{auth:r.auth,context:[o,...s],state:t,title:r.title}):await n.respond(u,{auth:r.auth,context:[o,...s]})",
);
await replaceExact(
  runtimePaths.telegram,
  "catch(e){log.error(`message delivery failed`,{error:e})}}async function dispatchCallbackQuery",
  "catch(e){log.error(`message delivery failed`,{error:e});throw e}}async function dispatchCallbackQuery",
);

// HITL callbacks are acknowledged only after application authentication selects auth and routing.
await replaceExact(
  runtimePaths.telegram,
  "if(e.query.data?.startsWith(TELEGRAM_HITL_CALLBACK_PREFIX)===!0){try{await n.telegram.answerCallbackQuery({callbackQueryId:e.query.id,text:`Answer received.`})}catch(e){log.warn(`Telegram callback-query acknowledgement failed`,{error:e})}if(!e.query.message||!t.chatId)return;try{await e.from(continuationTokenFromState(t)).respond([telegramCallbackInputResponse(e.query.data)],{auth:null})}catch(e){log.error(`callback query delivery failed`,{error:e})}return}",
  "if(e.query.data?.startsWith(TELEGRAM_HITL_CALLBACK_PREFIX)===!0){if(!e.query.message||!t.chatId)return;let r=continuationTokenFromState(t),i=e.config.onHitlCallbackQuery===void 0?{auth:null,continuationToken:e.config.resolveContinuationToken===void 0?r:await e.config.resolveContinuationToken(r)}:await e.config.onHitlCallbackQuery(n,e.query,r);if(i===null)return;try{await n.telegram.answerCallbackQuery({callbackQueryId:e.query.id,text:i.acknowledgementText??`Answer received.`})}catch(e){log.warn(`Telegram callback-query acknowledgement failed`,{error:e})}try{return await e.from(i.continuationToken??r).respond([telegramCallbackInputResponse(e.query.data)],{auth:i.auth})}catch(e){log.error(`callback query delivery failed`,{error:e});throw e}}",
);

// Telegram emits pseudo thread IDs on ordinary replies; only explicit topic messages define scope.
await replaceExact(
  runtimePaths.telegramInbound,
  "messageThreadId:typeof e.message_thread_id==`number`?e.message_thread_id:void 0",
  "messageThreadId:e.is_topic_message===!0&&typeof e.message_thread_id==`number`?e.message_thread_id:void 0",
  2,
);

// Public declarations match runtime hooks without exposing an unverified Request to the application.
await replaceExact(
  runtimePaths.telegramTypes,
  'import { type TelegramCallbackQuery, type TelegramChatType, type TelegramMessage } from "#public/channels/telegram/inbound.js";',
  'import { type TelegramCallbackQuery, type TelegramChatType, type TelegramMessage, type TelegramUpdate } from "#public/channels/telegram/inbound.js";\nimport type { Session } from "#channel/session.js";',
);
const telegramHookDeclarations = `/** Deadline controls supplied only by the verified application ingress. */
export interface TelegramDispatchControl {
    readonly updateId?: string;
    readonly signal: AbortSignal;
    readonly deadlineAt: string;
    readonly dispatchId: string;
    readonly onDispatch: (target: { resolveSession(): Promise<Session | undefined> }) => void;
}
/** Verified Telegram ingress hook context for durable application queues. */
export interface TelegramVerifiedUpdateContext {
    readonly attachSession: (sessionId: string) => Session;
    readonly raw: JsonObject;
    readonly update: TelegramUpdate;
    readonly dispatch: (update: TelegramUpdate, control?: TelegramDispatchControl) => Promise<Session | null | undefined>;
    readonly notifyTimeout: (update: TelegramUpdate, text: string, signal: AbortSignal) => Promise<unknown>;
    readonly waitUntil: (task: Promise<unknown>) => void;
}
/** Internal drain hook context using the native verified Telegram dispatcher. */
export interface TelegramDrainContext {
    readonly attachSession: (sessionId: string) => Session;
    readonly dispatch: (update: TelegramUpdate, control?: TelegramDispatchControl) => Promise<Session | null | undefined>;
    readonly notifyTimeout: (update: TelegramUpdate, text: string, signal: AbortSignal) => Promise<unknown>;
    readonly waitUntil: (task: Promise<unknown>) => void;
}
/** Application-authenticated result for a Telegram HITL callback. */
export type TelegramHitlCallbackResult = {
    readonly acknowledgementText?: string;
    readonly auth: SessionAuthContext | null;
    readonly continuationToken?: string;
} | null;
`;
await replaceExact(
  runtimePaths.telegramTypes,
  "/** Configuration for {@link telegramChannel}. */",
  `${telegramHookDeclarations}/** Configuration for {@link telegramChannel}. */`,
);
await replaceExact(
  runtimePaths.telegramTypes,
  "export type TelegramInboundResult = {\n    readonly auth: SessionAuthContext | null;\n    readonly context?: readonly string[];\n    /** Overrides the workflow run title without changing the message sent to the model. */\n    readonly title?: string;\n} | null;",
  "export type TelegramInboundResult = {\n    readonly auth: SessionAuthContext | null;\n    readonly context?: readonly string[];\n    readonly continuationToken?: string;\n    readonly message?: string;\n    readonly replyHandling?: \"message\";\n    /** Overrides the workflow run title without changing the message sent to the model. */\n    readonly title?: string;\n} | null;",
);
const telegramConfigHooks = `    /** Optional internal endpoint that resumes persisted ingress after process restarts. */
    readonly drainRoute?: string;
    /** Drains persisted updates through the native verified dispatcher. */
    readonly onDrain?: (context: TelegramDrainContext) => Response | Promise<Response>;
    /** Resolves a versioned token when no authenticated HITL callback hook is configured. */
    readonly resolveContinuationToken?: (baseToken: string) => string | Promise<string>;
    /** Authenticates the verified Telegram user before a HITL callback resumes Eve. */
    readonly onHitlCallbackQuery?: (ctx: TelegramContext, query: TelegramCallbackQuery, continuationToken: string) => TelegramHitlCallbackResult | Promise<TelegramHitlCallbackResult>;
    /** Runs after webhook verification and parsing, before native dispatch. */
    readonly onVerifiedUpdate?: (context: TelegramVerifiedUpdateContext) => Response | Promise<Response>;
`;
await replaceExact(
  runtimePaths.telegramTypes,
  "    /** Inbound message hook. Defaults to Telegram user auth and dispatch gating. */",
  `${telegramConfigHooks}    /** Inbound message hook. Defaults to Telegram user auth and dispatch gating. */`,
);
await replaceExact(
  runtimePaths.telegramIndexTypes,
  "type TelegramInboundResultOrPromise, type TelegramReceiveTarget, }",
  "type TelegramDispatchControl, type TelegramDrainContext, type TelegramHitlCallbackResult, type TelegramInboundResultOrPromise, type TelegramReceiveTarget, type TelegramVerifiedUpdateContext, }",
);
