/**
 * Reproducible @ai-sdk/openai-compatible 3.0.7 MiniMax patch installer.
 *
 * Constructs:
 * - Preserves MiniMax `reasoning_details` on generated and streamed reasoning parts.
 * - Serializes the exact details back into assistant history for interleaved thinking.
 * - Patches only the reviewed, version-pinned runtime artifact used by Node/Eve.
 * - Is idempotent and fails installation when the upstream artifact no longer matches.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const EXPECTED_OPENAI_COMPATIBLE_VERSION = "3.0.7";
const runtimePath = resolve(
  "node_modules/@ai-sdk/openai-compatible/dist/index.js",
);

async function replaceOnce(before: string, after: string): Promise<void> {
  const source = await readFile(runtimePath, "utf8");
  if (source.includes(after)) return;
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(
      `AGENT_OPENAI_COMPATIBLE_PATCH_MISMATCH: Не удалось однозначно применить проверенный патч к ${runtimePath}`,
    );
  }
  await writeFile(runtimePath, source.replace(before, after), "utf8");
}

function occurrenceCount(source: string, value: string): number {
  return source.split(value).length - 1;
}

async function replaceAllExact(
  before: string,
  after: string,
  expectedOccurrences: number,
): Promise<void> {
  const source = await readFile(runtimePath, "utf8");
  const beforeCount = occurrenceCount(source, before);
  const afterCount = occurrenceCount(source, after);
  if (beforeCount === 0 && afterCount === expectedOccurrences) return;
  if (beforeCount !== expectedOccurrences || afterCount !== 0) {
    throw new Error(
      `AGENT_OPENAI_COMPATIBLE_PATCH_MISMATCH: Ожидалось ${expectedOccurrences} совпадений проверенного патча в ${runtimePath}, найдено ${beforeCount}`,
    );
  }
  await writeFile(runtimePath, source.split(before).join(after), "utf8");
}

const packageJson = JSON.parse(
  await readFile(
    resolve("node_modules/@ai-sdk/openai-compatible/package.json"),
    "utf8",
  ),
) as { version?: string };
if (packageJson.version !== EXPECTED_OPENAI_COMPATIBLE_VERSION) {
  throw new Error(
    `AGENT_OPENAI_COMPATIBLE_PATCH_VERSION_UNSUPPORTED: Ожидалась @ai-sdk/openai-compatible ${EXPECTED_OPENAI_COMPATIBLE_VERSION}, установлена ${String(packageJson.version)}`,
  );
}

// Carry provider metadata from an AI SDK reasoning part back into assistant history.
await replaceOnce(
  `        let reasoning = "";
        const toolCalls = [];`,
  `        let reasoning = "";
        let reasoningDetails;
        const toolCalls = [];`,
);
await replaceOnce(
  `            case "reasoning": {
              reasoning += part.text;
              break;
            }`,
  `            case "reasoning": {
              reasoning += part.text;
              if (partMetadata.reasoningDetails !== void 0) {
                reasoningDetails = partMetadata.reasoningDetails;
              }
              break;
            }`,
);
await replaceOnce(
  `          ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
          tool_calls: toolCalls.length > 0 ? toolCalls : void 0,`,
  `          ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
          ...reasoningDetails === void 0 ? {} : { reasoning_details: reasoningDetails },
          tool_calls: toolCalls.length > 0 ? toolCalls : void 0,`,
);

// Accept MiniMax's documented structured reasoning envelope in JSON and SSE responses.
await replaceOnce(
  `var OpenAICompatibleChatResponseSchema = z3.looseObject({`,
  `var miniMaxReasoningDetailsSchema = z3.array(
  z3.looseObject({
    type: z3.string(),
    id: z3.string(),
    format: z3.string(),
    index: z3.number(),
    text: z3.string()
  })
).nullish();
var OpenAICompatibleChatResponseSchema = z3.looseObject({`,
);
await replaceAllExact(
  `        reasoning_content: z3.string().nullish(),
        reasoning: z3.string().nullish(),
        tool_calls: z3.array(`,
  `        reasoning_content: z3.string().nullish(),
        reasoning: z3.string().nullish(),
        reasoning_details: miniMaxReasoningDetailsSchema,
        tool_calls: z3.array(`,
  2,
);

// Attach exact details to non-stream reasoning so AI SDK response history retains them.
await replaceOnce(
  `    const reasoning = (_c = choice.message.reasoning_content) != null ? _c : choice.message.reasoning;
    if (reasoning != null && reasoning.length > 0) {
      content.push({
        type: "reasoning",
        text: reasoning
      });`,
  `    const reasoningDetails = choice.message.reasoning_details ?? void 0;
    const reasoning = choice.message.reasoning_content ?? choice.message.reasoning ?? reasoningDetails?.map((detail) => detail.text).join("\\n");
    if (reasoning != null && reasoning.length > 0) {
      content.push({
        type: "reasoning",
        text: reasoning,
        ...reasoningDetails === void 0 ? {} : {
          providerMetadata: { openaiCompatible: { reasoningDetails } }
        }
      });`,
);

// Keep the latest cumulative details and bind them to the streamed reasoning part.
await replaceOnce(
  `    let isActiveReasoning = false;
    let isActiveText = false;
    const convertUsage = (usage2) => this.convertUsage(usage2);`,
  `    let isActiveReasoning = false;
    let isActiveText = false;
    let reasoningDetails;
    const reasoningProviderMetadata = () => reasoningDetails == null ? void 0 : {
      openaiCompatible: { reasoningDetails }
    };
    const convertUsage = (usage2) => this.convertUsage(usage2);`,
);
await replaceOnce(
  `            const delta = choice.delta;
            const reasoningContent = (_b2 = delta.reasoning_content) != null ? _b2 : delta.reasoning;`,
  `            const delta = choice.delta;
            if (delta.reasoning_details != null) {
              reasoningDetails = delta.reasoning_details;
            }
            const reasoningContent = (_b2 = delta.reasoning_content) != null ? _b2 : delta.reasoning;`,
);
await replaceAllExact(
  `                controller.enqueue({
                  type: "reasoning-end",
                  id: "reasoning-0"
                });`,
  `                controller.enqueue({
                  type: "reasoning-end",
                  id: "reasoning-0",
                  providerMetadata: reasoningProviderMetadata()
                });`,
  2,
);
await replaceOnce(
  `              controller.enqueue({ type: "reasoning-end", id: "reasoning-0" });`,
  `              controller.enqueue({
                type: "reasoning-end",
                id: "reasoning-0",
                providerMetadata: reasoningProviderMetadata()
              });`,
);
