/**
 * Verified Telegram message to unified application-conversation timeline binding.
 *
 * Exports:
 * - `bindTelegramConversationTimeline`: resolves trust boundary and stores authorized private input.
 */
import type { TelegramMessage } from "../runtime/telegram/inbound.js";

import { AppError } from "./app-error.js";
import type { conversationRepository } from "./conversation-repository.js";
import type {
  ConversationTimelineRecordResult,
  conversationTimelineRepository,
} from "./conversation-timeline-repository.js";
import type { TimelineRecordResult } from "./telegram-group-journal-repository.js";

export async function bindTelegramConversationTimeline(input: {
  conversations: Pick<typeof conversationRepository, "getByChatId" | "getByGroupId">;
  existingGroupTimeline: TimelineRecordResult | null;
  familyId: string;
  groupId: string | null;
  message: TelegramMessage;
  timeline: Pick<typeof conversationTimelineRepository, "recordInbound">;
}): Promise<{
  conversation: Awaited<ReturnType<typeof conversationRepository.getByChatId>>;
  inboundTimeline: TimelineRecordResult | (ConversationTimelineRecordResult & { replyToAgent: false });
}> {
  const conversation = input.groupId
    ? await input.conversations.getByGroupId(input.groupId)
    : await input.conversations.getByChatId(input.message.chat.id);
  if (conversation.familyId !== input.familyId) {
    throw new AppError(
      "AGENT_CONVERSATION_SCOPE_MISMATCH",
      "Разговор относится к другой семейной области",
    );
  }
  if (input.message.chat.type === "private") {
    const stored = await input.timeline.recordInbound(conversation.id, input.message);
    return { conversation, inboundTimeline: { ...stored, replyToAgent: false } };
  }
  if (!input.existingGroupTimeline) {
    throw new AppError(
      "AGENT_CONVERSATION_TIMELINE_ENTRY_MISSING",
      "Для группового сообщения отсутствует запись единой истории",
    );
  }
  return { conversation, inboundTimeline: input.existingGroupTimeline };
}
