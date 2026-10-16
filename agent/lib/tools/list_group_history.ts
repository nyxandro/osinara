/**
 * Tool for the current verified Telegram group timeline.
 *
 * Export:
 * - `list_group_history`: bounded pagination and search without a model-selectable group scope.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { isoDateTimeWithOffset } from "../model-facing-datetime.js";
import { searchTelegramGroupHistory } from "../telegram-group-history.js";
import { telegramGroupJournalRepository } from "../telegram-group-journal-repository.js";
import { loadCurrentExternalGroupCapabilities } from "../tool-policy/external-group-live-policy.js";

const POSITIVE_BIGINT = z.string().regex(/^[1-9]\d*$/u);

export default defineTool({
  // Repeating it after a crash is safe: it only reads.
  replaySafe: true,
  description: [
    "Reads the saved history of the whole current verified Telegram group, including other forum topics; the group ID and scope come from the authorization and are not passed.",
    "The result contains records in chronological order and nextBeforeSequence for the next page; without filters the latest messages are returned.",
    "query searches for a case-insensitive literal substring in content: it is not a semantic search, a synonym search or a fuzzy search.",
    "participant requires an exact username without @; sequenceFrom and sequenceTo are inclusive, beforeSequence is exclusive, from and to are inclusive.",
    "limit from 1 to 100 applies after all filters; filters set together are combined with AND.",
    "Make only one call per model step, wait for and check its result before the next call: several parallel checks cannot be matched by the order of answers.",
    "Examples: the last 3: {\"limit\":3}; a literal search: {\"query\":\"кондиционер\",\"limit\":20}; a participant: {\"participant\":\"nyxandro\",\"limit\":20}; the next page: {\"beforeSequence\":\"320\",\"limit\":3}; a range: {\"sequenceFrom\":\"310\",\"sequenceTo\":\"315\"}; time: {\"from\":\"2026-07-31T16:00:00Z\",\"to\":\"2026-07-31T18:00:00Z\"}.",
  ].join(" "),
  inputSchema: z.object({
    beforeSequence: POSITIVE_BIGINT.describe(
      "An exclusive upper bound: return records with a sequence strictly less than the given one. For the next page pass nextBeforeSequence of the previous result.",
    ).optional(),
    from: isoDateTimeWithOffset(
      "The lower bound of sentAt, inclusive. Pass an ISO 8601 datetime with a UTC offset, for example 2026-07-31T16:00:00Z.",
    ).optional(),
    limit: z.number().int().min(1).max(100).describe(
      "The number of most recent matching records after all filters, from 1 to 100. Default 25.",
    ).optional(),
    participant: z.string().trim().min(1).max(200).describe(
      "The participant's exact username without the @ sign. Does not include the agent's answers or similar names and does no fuzzy search.",
    ).optional(),
    query: z.string().trim().min(1).max(500).describe(
      "A case-insensitive literal substring in content. Does not search for synonyms, matches by meaning or word forms without matching text.",
    ).optional(),
    sequenceFrom: POSITIVE_BIGINT.describe(
      "The lower bound of the model-visible sequence, inclusive; for example 310 includes #310.",
    ).optional(),
    sequenceTo: POSITIVE_BIGINT.describe(
      "The upper bound of the model-visible sequence, inclusive; for example 315 includes #315.",
    ).optional(),
    to: isoDateTimeWithOffset(
      "The upper bound of sentAt, inclusive. Pass an ISO 8601 datetime with a UTC offset, for example 2026-07-31T18:00:00Z.",
    ).optional(),
  }).strict(),
  async execute(input, ctx) {
    return await searchTelegramGroupHistory(
      telegramGroupJournalRepository,
      input,
      ctx,
      loadCurrentExternalGroupCapabilities,
    );
  },
});
