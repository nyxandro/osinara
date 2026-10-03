/**
 * Turn-scoped instructions: application resolvers and the messages a turn adds to history.
 *
 * Exports:
 * - `InstructionResolver`: one named block source; `resolveTurnInstructions` runs them in order.
 * - `instructionTurnMessages`: history as resolvers must see it — with this turn's input.
 * - `turnInputMessages`: what a turn appends after the history before its first model step.
 *
 * - Resolvers see the current message and its context lines, so memory retrieval searches by the
 *   question being asked.
 * - A failing resolver stops the turn before the model call: a turn never runs without its
 *   trust-zone rules. The application resolvers turn every expected failure into an explicit block.
 * - Resolvers run once per turn.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import type { ModelMessage, UserContent } from "ai";

import { AppError } from "../../lib/app-error.js";
import type { DynamicResolveContext } from "../context.js";

export interface InstructionBlock {
  readonly content: string;
  readonly role: "system" | "user";
}

export interface InstructionResolveContext extends DynamicResolveContext {
  readonly turnId: string;
}

export interface InstructionResolver {
  readonly name: string;
  resolve(context: InstructionResolveContext): InstructionBlock | null | Promise<InstructionBlock | null>;
}

export interface TurnInput {
  readonly context: readonly string[];
  readonly message?: string | UserContent;
}

export interface TurnInstructions {
  /** System blocks in resolver order; they live only in this turn's requests. */
  readonly system: readonly string[];
  /** User-role blocks; they are written into history once, before the turn's input. */
  readonly user: readonly ModelMessage[];
}

function normalizeUserContent(content: string | UserContent | undefined): string | UserContent | undefined {
  if (content === undefined) return undefined;
  if (typeof content === "string") return content.trim().length > 0 ? content : undefined;
  const parts = content.filter((part) => part.type !== "text" || part.text.trim().length > 0);
  if (parts.length === 0) return undefined;
  return parts.length === content.length ? content : parts;
}

export function instructionTurnMessages(history: readonly ModelMessage[], input: TurnInput): readonly ModelMessage[] {
  const message = normalizeUserContent(input.message);
  if (message === undefined) return history;
  return [
    ...history,
    ...input.context.map((entry): ModelMessage => ({ role: "user", content: entry })),
    { role: "user", content: message },
  ];
}

export function turnInputMessages(input: TurnInput & { readonly userInstructions: readonly ModelMessage[] }): ModelMessage[] {
  const message = normalizeUserContent(input.message);
  return [
    ...input.userInstructions,
    ...input.context.map((entry): ModelMessage => ({ role: "user", content: entry })),
    ...(message === undefined ? [] : [{ role: "user", content: message } as ModelMessage]),
  ];
}

export async function resolveTurnInstructions(
  resolvers: readonly InstructionResolver[],
  context: InstructionResolveContext,
): Promise<TurnInstructions> {
  const blocks = await Promise.all(resolvers.map(async (resolver) => {
    try {
      return await resolver.resolve(context);
    } catch (error) {
      throw new AppError(
        "AGENT_TURN_INSTRUCTIONS_FAILED",
        "Не удалось подготовить инструкции хода. Попробуйте отправить сообщение ещё раз",
        { cause: error, details: { resolver: resolver.name } },
      );
    }
  }));
  const system: string[] = [];
  const user: ModelMessage[] = [];
  for (const block of blocks) {
    const content = block?.content.trim();
    if (!block || !content) continue;
    if (block.role === "system") system.push(content);
    else user.push({ role: "user", content });
  }
  return { system, user };
}
