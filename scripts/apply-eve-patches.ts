/**
 * Reproducible local Eve 0.22.5 patch installer.
 *
 * Constructs:
 * - Adds a verified Telegram update hook around the native dispatcher.
 * - Makes the native dispatcher return its Eve session for FIFO coordination.
 * - Lets the application version continuation tokens for rotation, including HITL callbacks.
 * - Lets the application authenticate the exact Telegram user resuming a HITL callback.
 * - Propagates `input.requested` adapter failures so unbound approvals never park fail-open.
 * - Supports a zero-depth subagent limit so the root agent can disable delegation completely.
 * - Routes local Workflow recovery through Eve's configured queue namespace.
 * - Fails installation when the pinned Eve artifact no longer matches the reviewed source.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const EXPECTED_EVE_VERSION = "0.22.5";
const telegramRuntimePath = resolve(
  "node_modules/eve/dist/src/public/channels/telegram/telegramChannel.js",
);
const channelAdapterRuntimePath = resolve(
  "node_modules/eve/dist/src/channel/adapter.js",
);
const channelAdapterTypesPath = resolve(
  "node_modules/eve/dist/src/channel/adapter.d.ts",
);
const telegramTypesPath = resolve(
  "node_modules/eve/dist/src/public/channels/telegram/telegramChannel.d.ts",
);
const telegramIndexTypesPath = resolve(
  "node_modules/eve/dist/src/public/channels/telegram/index.d.ts",
);
const workflowWorldRuntimePath = resolve(
  "node_modules/eve/dist/src/compiled/_chunks/workflow/dist-DnBjuNAZ.js",
);
const agentDefinitionRuntimePath = resolve(
  "node_modules/eve/dist/src/internal/authored-definition/core.js",
);
const compiledManifestRuntimePath = resolve(
  "node_modules/eve/dist/src/compiler/manifest.js",
);
const subagentDepthRuntimePath = resolve(
  "node_modules/eve/dist/src/harness/subagent-depth.js",
);

async function replaceOnce(
  path: string,
  before: string,
  after: string,
  acceptedFinalMarkers: readonly string[] = [],
): Promise<void> {
  const source = await readFile(path, "utf8");
  if (source.includes(after) || acceptedFinalMarkers.some((marker) => source.includes(marker))) return;
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(
      `AGENT_EVE_PATCH_MISMATCH: Не удалось однозначно применить проверенный патч к ${path}`,
    );
  }
  await writeFile(path, source.replace(before, after), "utf8");
}

async function replaceAll(path: string, before: string, after: string): Promise<void> {
  const source = await readFile(path, "utf8");
  if (!source.includes(before)) return;
  await writeFile(path, source.split(before).join(after), "utf8");
}

const evePackage = JSON.parse(
  await readFile(resolve("node_modules/eve/package.json"), "utf8"),
) as { version?: string };
if (evePackage.version !== EXPECTED_EVE_VERSION) {
  throw new Error(
    `AGENT_EVE_PATCH_VERSION_UNSUPPORTED: Ожидалась Eve ${EXPECTED_EVE_VERSION}, установлена ${String(evePackage.version)}`,
  );
}

// A failed durable approval binding must fail the turn instead of parking without authorization.
await replaceOnce(
  channelAdapterRuntimePath,
  "catch(n){log.error(`adapter event handler threw — event swallowed`,{adapterKind:getAdapterKind(e),eventType:t.type,error:n})}return t",
  "catch(n){log.error(`adapter event handler threw`,{adapterKind:getAdapterKind(e),eventType:t.type,error:n});if(t.type===`input.requested`)throw n}return t",
);
await replaceOnce(
  channelAdapterTypesPath,
  " * Throwing handlers are logged and swallowed so a downstream delivery\n * failure does not corrupt the event stream write path.",
  " * Throwing handlers are logged and swallowed except for `input.requested`, whose\n * failure propagates so an unbound human approval cannot remain parked fail-open.",
);

// Eve registers namespaced queues, so startup recovery must not publish to the unnamespaced topic.
await replaceOnce(
  workflowWorldRuntimePath,
  "await t(`__wkf_workflow_${e.workflowName}`,{runId:e.runId}),r++",
  "await t(`${Um(`workflow`,Hm())}${e.workflowName}`,{runId:e.runId}),r++",
);

// Eve's depth comparison already treats the root as depth zero, but 0 is rejected by config
// normalization and discarded by runtime parsing. Preserve every positive-depth behavior.
await replaceOnce(
  agentDefinitionRuntimePath,
  "i.maxSubagentDepth!==void 0&&(a.maxSubagentDepth=expectPositiveInteger(i.maxSubagentDepth,r))",
  "i.maxSubagentDepth!==void 0&&(a.maxSubagentDepth=(()=>{let e=i.maxSubagentDepth;if(typeof e!=`number`||!Number.isInteger(e)||e<0)throw Error(r);return e})())",
);
await replaceOnce(
  compiledManifestRuntimePath,
  "maxSubagentDepth:z.number().int().positive().optional(),maxSubagents",
  "maxSubagentDepth:z.number().int().nonnegative().optional(),maxSubagents",
);
await replaceOnce(
  subagentDepthRuntimePath,
  "function parseSubagentMaxDepth(e){return typeof e==`number`&&Number.isInteger(e)&&e>0?e:void 0}",
  "function parseSubagentMaxDepth(e){return typeof e==`number`&&Number.isInteger(e)&&e>=0?e:void 0}",
);

// The hook receives only a verified and parsed update while retaining Eve's native channel adapter.
await replaceOnce(
  telegramRuntimePath,
  "let u=parseTelegramUpdate(c);return u===null?new Response(`ok`):u.kind===`message`?(o(dispatchMessage({config:e,message:u.message,onMessage:n,send:a,uploadPolicy:t})),new Response(`ok`)):(o(dispatchCallbackQuery({config:e,query:u.callbackQuery,send:a})),new Response(`ok`))",
  "let u=parseTelegramUpdate(c);if(u===null)return new Response(`ok`);let d=l=>l.kind===`message`?dispatchMessage({config:e,message:l.message,onMessage:n,send:a,uploadPolicy:t}):dispatchCallbackQuery({config:e,query:l.callbackQuery,send:a});return e.onVerifiedUpdate!==void 0?e.onVerifiedUpdate({dispatch:d,raw:c,update:u,waitUntil:o}):(o(d(u)),new Response(`ok`))",
);

// Returning the session lets the application wait for `session.waiting` before releasing FIFO.
await replaceOnce(
  telegramRuntimePath,
  "try{await e.send({inputResponses:u,message:a,context:[o,...s]},{auth:r.auth,continuationToken:continuationTokenFromState(t),state:t})}catch(e){log.error(`message delivery failed`,{error:e})}",
  "try{return await e.send({inputResponses:u,message:a,context:[o,...s]},{auth:r.auth,continuationToken:r.continuationToken??continuationTokenFromState(t),state:t})}catch(e){log.error(`message delivery failed`,{error:e});throw e}",
);
await replaceOnce(
  telegramRuntimePath,
  "try{await e.send({inputResponses:[telegramCallbackInputResponse(e.query.data)]},{auth:null,continuationToken:continuationTokenFromState(t),state:t})}catch(e){log.error(`callback query delivery failed`,{error:e})}return",
  "try{return await e.send({inputResponses:[telegramCallbackInputResponse(e.query.data)]},{auth:null,continuationToken:e.config.resolveContinuationToken===void 0?continuationTokenFromState(t):await e.config.resolveContinuationToken(continuationTokenFromState(t)),state:t})}catch(e){log.error(`callback query delivery failed`,{error:e});throw e}",
  ["onHitlCallbackQuery"],
);

// Message authorization may select a versioned continuation token for the application session.
await replaceOnce(
  telegramRuntimePath,
  "{auth:r.auth,continuationToken:continuationTokenFromState(t),state:t}",
  "{auth:r.auth,continuationToken:r.continuationToken??continuationTokenFromState(t),state:t}",
);
// HITL callbacks are resumed only after the application binds the exact verified Telegram user.
await replaceOnce(
  telegramRuntimePath,
  "if(e.query.data?.startsWith(TELEGRAM_HITL_CALLBACK_PREFIX)===!0){try{await n.telegram.answerCallbackQuery({callbackQueryId:e.query.id,text:`Answer received.`})}catch(e){log.warn(`Telegram callback-query acknowledgement failed`,{error:e})}if(!e.query.message||!t.chatId)return;try{return await e.send({inputResponses:[telegramCallbackInputResponse(e.query.data)]},{auth:null,continuationToken:e.config.resolveContinuationToken===void 0?continuationTokenFromState(t):await e.config.resolveContinuationToken(continuationTokenFromState(t)),state:t})}",
  "if(e.query.data?.startsWith(TELEGRAM_HITL_CALLBACK_PREFIX)===!0){if(!e.query.message||!t.chatId)return;let r=continuationTokenFromState(t),i=e.config.onHitlCallbackQuery===void 0?{auth:null,continuationToken:e.config.resolveContinuationToken===void 0?r:await e.config.resolveContinuationToken(r)}:await e.config.onHitlCallbackQuery(n,e.query,r);if(i===null)return;try{await n.telegram.answerCallbackQuery({callbackQueryId:e.query.id,text:`Answer received.`})}catch(e){log.warn(`Telegram callback-query acknowledgement failed`,{error:e})}try{return await e.send({inputResponses:[telegramCallbackInputResponse(e.query.data)]},{auth:i.auth,continuationToken:i.continuationToken??r,state:t})}",
  [
    "let r=continuationTokenFromState(t),i=e.config.onHitlCallbackQuery",
    "let r=e.config.resolveContinuationToken===void 0?continuationTokenFromState(t)",
  ],
);
// Normalize installations produced by the previous authenticated-callback patch revision.
await replaceOnce(
  telegramRuntimePath,
  "if(e.query.data?.startsWith(TELEGRAM_HITL_CALLBACK_PREFIX)===!0){if(!e.query.message||!t.chatId)return;let r=e.config.resolveContinuationToken===void 0?continuationTokenFromState(t):await e.config.resolveContinuationToken(continuationTokenFromState(t)),i=e.config.onHitlCallbackQuery===void 0?{auth:null}:await e.config.onHitlCallbackQuery(n,e.query,r);if(i===null)return;try{await n.telegram.answerCallbackQuery({callbackQueryId:e.query.id,text:`Answer received.`})}catch(e){log.warn(`Telegram callback-query acknowledgement failed`,{error:e})}try{return await e.send({inputResponses:[telegramCallbackInputResponse(e.query.data)]},{auth:i.auth,continuationToken:i.continuationToken??r,state:t})}",
  "if(e.query.data?.startsWith(TELEGRAM_HITL_CALLBACK_PREFIX)===!0){if(!e.query.message||!t.chatId)return;let r=continuationTokenFromState(t),i=e.config.onHitlCallbackQuery===void 0?{auth:null,continuationToken:e.config.resolveContinuationToken===void 0?r:await e.config.resolveContinuationToken(r)}:await e.config.onHitlCallbackQuery(n,e.query,r);if(i===null)return;try{await n.telegram.answerCallbackQuery({callbackQueryId:e.query.id,text:`Answer received.`})}catch(e){log.warn(`Telegram callback-query acknowledgement failed`,{error:e})}try{return await e.send({inputResponses:[telegramCallbackInputResponse(e.query.data)]},{auth:i.auth,continuationToken:i.continuationToken??r,state:t})}",
);
await replaceOnce(
  telegramRuntimePath,
  "catch(e){log.error(`message handler failed`,{error:e});return}if(r==null)return",
  "catch(e){log.error(`message handler failed`,{error:e});throw e}if(r==null)return",
);
await replaceOnce(
  telegramRuntimePath,
  "return e.onVerifiedUpdate!==void 0?e.onVerifiedUpdate({dispatch:d,raw:c,update:u,waitUntil:o}):(o(d(u)),new Response(`ok`))})],async receive",
  "return e.onVerifiedUpdate!==void 0?e.onVerifiedUpdate({dispatch:d,raw:c,update:u,waitUntil:o}):(o(d(u)),new Response(`ok`))}),...e.onDrain===void 0?[]:[POST(e.drainRoute??`/eve/v1/telegram-drain`,async(r,{send:a,waitUntil:o})=>{if(await verifyInbound(r,e.credentials)===null)return new Response(`unauthorized`,{status:401});let d=l=>l.kind===`message`?dispatchMessage({config:e,message:l.message,onMessage:n,send:a,uploadPolicy:t}):dispatchCallbackQuery({config:e,query:l.callbackQuery,send:a});return e.onDrain({dispatch:d,waitUntil:o})})]],async receive",
);

// Type declarations mirror the runtime hook and deliberately expose no unverified request data.
await replaceOnce(
  telegramTypesPath,
  'import { type TelegramCallbackQuery, type TelegramChatType, type TelegramMessage } from "#public/channels/telegram/inbound.js";',
  'import { type TelegramCallbackQuery, type TelegramChatType, type TelegramMessage, type TelegramUpdate } from "#public/channels/telegram/inbound.js";\nimport type { Session } from "#channel/session.js";',
);
// Earlier patch revisions could duplicate declarations on repeated postinstall. Normalize the
// reviewed blocks before inserting the canonical declarations exactly once.
const verifiedUpdateDeclaration = "/** Verified Telegram ingress hook context for durable application queues. */\nexport interface TelegramVerifiedUpdateContext {\n    readonly raw: JsonObject;\n    readonly update: TelegramUpdate;\n    readonly dispatch: (update: TelegramUpdate) => Promise<Session | null | undefined>;\n    readonly waitUntil: (task: Promise<unknown>) => void;\n}\n";
const drainDeclaration = "/** Internal drain hook context using the same native Telegram dispatcher. */\nexport interface TelegramDrainContext {\n    readonly dispatch: (update: TelegramUpdate) => Promise<Session | null | undefined>;\n    readonly waitUntil: (task: Promise<unknown>) => void;\n}\n";
const hitlCallbackDeclaration = "/** Application-authenticated result for a Telegram HITL callback. */\nexport type TelegramHitlCallbackResult = {\n    readonly auth: SessionAuthContext | null;\n    readonly continuationToken?: string;\n} | null;\n";
await replaceAll(telegramTypesPath, verifiedUpdateDeclaration, "");
await replaceAll(telegramTypesPath, drainDeclaration, "");
await replaceAll(telegramTypesPath, hitlCallbackDeclaration, "");
await replaceOnce(
  telegramTypesPath,
  "/** Configuration for {@link telegramChannel}. */",
  `${verifiedUpdateDeclaration}${drainDeclaration}${hitlCallbackDeclaration}/** Configuration for {@link telegramChannel}. */`,
);
await replaceOnce(
  telegramTypesPath,
  "    readonly context?: readonly string[];\n} | null;",
  "    readonly context?: readonly string[];\n    readonly continuationToken?: string;\n} | null;",
);
const oldVerifiedConfig = "    /** Runs after webhook verification and parsing, before native dispatch. */\n    readonly onVerifiedUpdate?: (context: TelegramVerifiedUpdateContext) => Response | Promise<Response>;\n";
const oldDrainConfig = "    /** Optional internal endpoint that resumes persisted ingress after process restarts. */\n    readonly drainRoute?: string;\n    /** Drains persisted updates through the native dispatcher. */\n    readonly onDrain?: (context: TelegramDrainContext) => Response | Promise<Response>;\n";
const oldResolverConfig = "    /** Resolves a versioned token for auth-less callback queries. */\n    readonly resolveContinuationToken?: (baseToken: string) => string | Promise<string>;\n";
const hitlCallbackConfig = "    /** Authenticates a verified Telegram user before a HITL callback resumes Eve. */\n    readonly onHitlCallbackQuery?: (ctx: TelegramContext, query: TelegramCallbackQuery, continuationToken: string) => TelegramHitlCallbackResult | Promise<TelegramHitlCallbackResult>;\n";
await replaceAll(telegramTypesPath, oldDrainConfig, "");
await replaceAll(telegramTypesPath, oldResolverConfig, "");
await replaceAll(telegramTypesPath, hitlCallbackConfig, "");
await replaceAll(telegramTypesPath, oldVerifiedConfig, "");
await replaceOnce(
  telegramTypesPath,
  "    /** Inbound message hook. Defaults to Telegram user auth and dispatch gating. */",
  `${oldDrainConfig}${oldResolverConfig}${hitlCallbackConfig}${oldVerifiedConfig}    /** Inbound message hook. Defaults to Telegram user auth and dispatch gating. */`,
);
await replaceOnce(
  telegramIndexTypesPath,
  "type TelegramInboundResultOrPromise, type TelegramReceiveTarget, }",
  "type TelegramInboundResultOrPromise, type TelegramReceiveTarget, type TelegramVerifiedUpdateContext, }",
);
// Canonicalize prior patch revisions before inserting each public type exactly once.
await replaceAll(telegramIndexTypesPath, "type TelegramDrainContext, ", "");
await replaceAll(telegramIndexTypesPath, "type TelegramHitlCallbackResult, ", "");
await replaceOnce(
  telegramIndexTypesPath,
  "type TelegramInboundResultOrPromise, type TelegramReceiveTarget, type TelegramVerifiedUpdateContext, }",
  "type TelegramDrainContext, type TelegramHitlCallbackResult, type TelegramInboundResultOrPromise, type TelegramReceiveTarget, type TelegramVerifiedUpdateContext, }",
);
