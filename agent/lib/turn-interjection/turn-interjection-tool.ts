/**
 * Tool wrapper that delivers waiting chat messages together with a successful tool result.
 *
 * Exports:
 * - `TurnInterjection`: per-call lookup of waiting messages and release of a failed attempt's claims.
 * - `withTurnInterjection`: wraps one tool without changing its descriptor or failure behavior.
 *
 * Key constructs:
 * - Eve hands `toModelOutput` only the stored output, so the block travels inside the output of
 *   this one call. Every other call keeps its exact output and projection.
 * - The lookup is an addition to the result. When it fails, the tool result is returned unchanged
 *   and the waiting message still gets its own ordinary turn, so nothing is lost.
 */
import { defineTool, type ToolContext, type ToolDefinition, type ToolModelOutput } from "eve/tools";

type AnyToolDefinition = ToolDefinition<any, any>;

export interface TurnInterjection {
  /** Returns the marked block for this call, or null when nothing waits. */
  collect(ctx: ToolContext): Promise<string | null>;
  /** Frees whatever an earlier attempt of this call claimed; never throws. */
  release(ctx: ToolContext): Promise<void>;
}

const OUTPUT_KEY = "osinaraTurnInterjection";

interface InterjectedOutput {
  readonly [OUTPUT_KEY]: string;
  readonly result: unknown;
}

// `result` disappears from the stored JSON when the tool returned undefined, so only the key counts.
function isInterjectedOutput(output: unknown): output is InterjectedOutput {
  return typeof output === "object" && output !== null && !Array.isArray(output) &&
    Object.hasOwn(output, OUTPUT_KEY) && typeof (output as Record<string, unknown>)[OUTPUT_KEY] === "string";
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

// Eve 0.40 recognizes its control values by `__eve*` brand keys, e.g. `__eveAuthorization`.
function isEveControlValue(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    Object.keys(value).some((key) => key.startsWith("__eve"));
}

// Mirrors Eve 0.40 for a tool without its own projection: text stays text, everything else is JSON.
function defaultModelOutput(output: unknown): ToolModelOutput {
  return typeof output === "string"
    ? { type: "text", value: output }
    : { type: "json", value: output ?? null };
}

function appendBlock(output: ToolModelOutput, block: string): ToolModelOutput {
  if (output.type === "content") {
    return { type: "content", value: [...output.value, { text: block, type: "text" }] };
  }
  const own = output.type === "text" ? output.value : JSON.stringify(output.value);
  return { type: "text", value: `${own}\n\n${block}` };
}

export function withTurnInterjection(
  definition: AnyToolDefinition,
  interjection: TurnInterjection,
): AnyToolDefinition {
  const project = async (output: unknown): Promise<ToolModelOutput> =>
    definition.toModelOutput ? await definition.toModelOutput(output) : defaultModelOutput(output);
  return defineTool({
    ...definition,
    async execute(input: unknown, ctx: ToolContext) {
      let result: unknown;
      try {
        result = await definition.execute(input, ctx);
      } catch (error) {
        // A retry of this call after an earlier attempt returned a block must not leave that block
        // counted as seen once the next step starts.
        await interjection.release(ctx);
        throw error;
      }
      // A streaming tool settles through its own iterator; its final snapshot cannot carry a block.
      // An Eve control value, such as a sign-in request, must reach the runtime exactly as returned.
      if (isAsyncIterable(result) || isEveControlValue(result)) return result;
      let block: string | null;
      try {
        block = await interjection.collect(ctx);
      } catch (error) {
        console.error(JSON.stringify({
          callId: ctx.callId ?? null,
          code: "AGENT_TURN_INTERJECTION_FAILED",
          error: error instanceof Error ? error.message : String(error),
          toolName: ctx.toolName ?? null,
        }));
        return result;
      }
      return block === null ? result : { [OUTPUT_KEY]: block, result } satisfies InterjectedOutput;
    },
    async toModelOutput(output: unknown) {
      if (!isInterjectedOutput(output)) return await project(output);
      return appendBlock(await project(output.result), output[OUTPUT_KEY]);
    },
  } as AnyToolDefinition) as AnyToolDefinition;
}
