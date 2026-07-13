/**
 * Reproducible local Eve 0.22.5 patch installer.
 *
 * Constructs:
 * - Adds a verified Telegram update hook around the native dispatcher.
 * - Makes the native dispatcher return its Eve session for FIFO coordination.
 * - Lets the application version continuation tokens for rotation, including HITL callbacks.
 * - Preserves a verified Telegram photo MIME when the download endpoint returns generic binary.
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
const telegramAttachmentsRuntimePath = resolve(
  "node_modules/eve/dist/src/public/channels/telegram/attachments.js",
);
const telegramTypesPath = resolve(
  "node_modules/eve/dist/src/public/channels/telegram/telegramChannel.d.ts",
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

async function replaceOnce(path: string, before: string, after: string): Promise<void> {
  const source = await readFile(path, "utf8");
  if (source.includes(after)) return;
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

// Telegram's file endpoint can return application/octet-stream even for native photo updates.
// The application handler has already validated the real image bytes before Eve stages this file.
await replaceOnce(
  telegramAttachmentsRuntimePath,
  "l=s.headers.get(`content-type`)??i.mediaType??`application/octet-stream`",
  "l=(()=>{let e=s.headers.get(`content-type`);return e===null||e.split(`;`,1)[0].trim().toLowerCase()===`application/octet-stream`?i.mediaType??e??`application/octet-stream`:e})()",
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
);

// Message authorization may select a versioned continuation, while callbacks resolve the
// version from the application route table because Telegram sends them without session auth.
await replaceOnce(
  telegramRuntimePath,
  "{auth:r.auth,continuationToken:continuationTokenFromState(t),state:t}",
  "{auth:r.auth,continuationToken:r.continuationToken??continuationTokenFromState(t),state:t}",
);
await replaceOnce(
  telegramRuntimePath,
  "{auth:null,continuationToken:continuationTokenFromState(t),state:t}",
  "{auth:null,continuationToken:e.config.resolveContinuationToken===void 0?continuationTokenFromState(t):await e.config.resolveContinuationToken(continuationTokenFromState(t)),state:t}",
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
await replaceAll(telegramTypesPath, verifiedUpdateDeclaration, "");
await replaceAll(telegramTypesPath, drainDeclaration, "");
await replaceOnce(
  telegramTypesPath,
  "/** Configuration for {@link telegramChannel}. */",
  `${verifiedUpdateDeclaration}${drainDeclaration}/** Configuration for {@link telegramChannel}. */`,
);
await replaceOnce(
  telegramTypesPath,
  "    readonly context?: readonly string[];\n} | null;",
  "    readonly context?: readonly string[];\n    readonly continuationToken?: string;\n} | null;",
);
const oldVerifiedConfig = "    /** Runs after webhook verification and parsing, before native dispatch. */\n    readonly onVerifiedUpdate?: (context: TelegramVerifiedUpdateContext) => Response | Promise<Response>;\n";
const oldDrainConfig = "    /** Optional internal endpoint that resumes persisted ingress after process restarts. */\n    readonly drainRoute?: string;\n    /** Drains persisted updates through the native dispatcher. */\n    readonly onDrain?: (context: TelegramDrainContext) => Response | Promise<Response>;\n";
const oldResolverConfig = "    /** Resolves a versioned token for auth-less callback queries. */\n    readonly resolveContinuationToken?: (baseToken: string) => string | Promise<string>;\n";
await replaceAll(telegramTypesPath, oldDrainConfig, "");
await replaceAll(telegramTypesPath, oldResolverConfig, "");
await replaceAll(telegramTypesPath, oldVerifiedConfig, "");
await replaceOnce(
  telegramTypesPath,
  "    /** Inbound message hook. Defaults to Telegram user auth and dispatch gating. */",
  `${oldDrainConfig}${oldResolverConfig}${oldVerifiedConfig}    /** Inbound message hook. Defaults to Telegram user auth and dispatch gating. */`,
);
await replaceOnce(
  resolve("node_modules/eve/dist/src/public/channels/telegram/index.d.ts"),
  "type TelegramInboundResultOrPromise, type TelegramReceiveTarget, }",
  "type TelegramInboundResultOrPromise, type TelegramReceiveTarget, type TelegramVerifiedUpdateContext, }",
);
await replaceOnce(
  resolve("node_modules/eve/dist/src/public/channels/telegram/index.d.ts"),
  "type TelegramInboundResultOrPromise, type TelegramReceiveTarget, type TelegramVerifiedUpdateContext, }",
  "type TelegramDrainContext, type TelegramInboundResultOrPromise, type TelegramReceiveTarget, type TelegramVerifiedUpdateContext, }",
);
