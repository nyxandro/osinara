/**
 * Reference-request scenarios of the bench.
 *
 * Exports:
 * - Telegram identities of the reference family, isolated from the conversation eval identities.
 * - `REFERENCE_SCENARIOS` and `referenceRequestIdentity`: which scenario, and whether its subagent
 *   child, one model request belongs to.
 *
 * A scenario is named by the marker `reference-probe-<scenario>` in the newest user message that
 * carries one. A silent memory review quotes earlier chat messages, so it is recognized by its
 * mode instructions before any quoted marker.
 */
export const REFERENCE_MARKER_PREFIX = "reference-probe-";
export const REFERENCE_OWNER_TELEGRAM_ID = 912;
export const REFERENCE_PEER_BOT_TELEGRAM_ID = 911;
export const REFERENCE_FAMILY_CHAT_ID = -910_000_102;
export const REFERENCE_EXTERNAL_CHAT_ID = -910_000_101;
export const REFERENCE_CHAT_IDS: ReadonlySet<number> = new Set([
  REFERENCE_OWNER_TELEGRAM_ID, REFERENCE_FAMILY_CHAT_ID, REFERENCE_EXTERNAL_CHAT_ID,
]);

export const REFERENCE_SCENARIOS = [
  "private-first",
  "private-second",
  "family-group",
  "external-human",
  "external-bot",
  "approval",
  "question",
  "scheduled-isolated",
  "scheduled-conversation",
  "memory-review",
] as const;
export type ReferenceScenario = (typeof REFERENCE_SCENARIOS)[number];

const MEMORY_REVIEW_MODE_TITLE = "# Текущий режим: тихая проверка памяти группы";
const MARKER_PATTERN = /(child:)?reference-probe-([a-z]+(?:-[a-z]+)*)/gu;

export interface ReferenceTextMessage {
  readonly role: string;
  readonly text: string;
}

export interface ReferenceRequestIdentity {
  readonly child: boolean;
  readonly scenario: ReferenceScenario;
}

function requireScenario(name: string): ReferenceScenario {
  const scenario = REFERENCE_SCENARIOS.find((candidate) => candidate === name);
  if (!scenario) throw new Error(`TEST_REFERENCE_SCENARIO_UNKNOWN: ${name}`);
  return scenario;
}

export function referenceMarker(scenario: ReferenceScenario): string {
  return `${REFERENCE_MARKER_PREFIX}${scenario}`;
}

export function referenceRequestIdentity(
  messages: readonly ReferenceTextMessage[],
): ReferenceRequestIdentity | null {
  const userTexts = messages.filter((message) => message.role === "user").map((message) => message.text);
  if (!userTexts.some((text) => text.includes(REFERENCE_MARKER_PREFIX))) return null;
  if (messages.some((message) => message.role === "system" && message.text.includes(MEMORY_REVIEW_MODE_TITLE))) {
    return { child: false, scenario: "memory-review" };
  }
  for (const text of [...userTexts].reverse()) {
    const match = [...text.matchAll(MARKER_PATTERN)].at(-1);
    if (match) return { child: match[1] !== undefined, scenario: requireScenario(match[2]!) };
  }
  return null;
}
