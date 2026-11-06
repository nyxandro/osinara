/**
 * What a person sees, privately, on each outcome of a private question (#467). Fixed by the application,
 * not written by the model; every refusal and failure carries its stable code.
 */
export const PRIVATE_QUESTION_TEXTS = Object.freeze({
  cancelled: "Ответ отменён. Спроси ещё раз. (AGENT_PRIVATE_QUESTION_CANCELLED)",
  emptyAnswer: "Не нашла, что ответить. Попробуй спросить иначе. (AGENT_PRIVATE_ANSWER_EMPTY)",
  emptyQuestion: "Напиши вопрос сразу после команды, например: /me что решили по срокам?",
  failed: "Не получилось ответить: внутренний сбой. Спроси ещё раз чуть позже. (AGENT_PRIVATE_QUESTION_FAILED)",
  modelUnavailable: "Модель сейчас недоступна. Спроси ещё раз через несколько минут. (AGENT_PRIVATE_QUESTION_MODEL_UNAVAILABLE)",
  notAllowed: "Бот не может ответить тебе в этом чате. (AGENT_PRIVATE_QUESTION_NOT_ALLOWED)",
  ownerOnly: "В этом чате бот отвечает только владельцу. (AGENT_PRIVATE_QUESTION_NOT_ALLOWED)",
  placeholder: "Думаю… Ответ увидишь только ты.",
  tooLong: "Ответ получился длиннее, чем помещается в одно личное сообщение. Спроси уже — например, про одну тему. (AGENT_PRIVATE_ANSWER_TOO_LONG)",
  updating: "Бот сейчас обновляется. Спроси ещё раз через несколько минут. (AGENT_PRIVATE_QUESTION_UPDATING)",
});

/** Codes recorded with a refused or failed private question; the same as in the texts above. */
export const PRIVATE_QUESTION_CODES = Object.freeze({
  cancelled: "AGENT_PRIVATE_QUESTION_CANCELLED",
  emptyAnswer: "AGENT_PRIVATE_ANSWER_EMPTY",
  emptyQuestion: "AGENT_PRIVATE_QUESTION_EMPTY",
  failed: "AGENT_PRIVATE_QUESTION_FAILED",
  modelUnavailable: "AGENT_PRIVATE_QUESTION_MODEL_UNAVAILABLE",
  notAllowed: "AGENT_PRIVATE_QUESTION_NOT_ALLOWED",
  placeholderRejected: "AGENT_PRIVATE_QUESTION_PLACEHOLDER_REJECTED",
  tooLong: "AGENT_PRIVATE_ANSWER_TOO_LONG",
  updating: "AGENT_PRIVATE_QUESTION_UPDATING",
  windowMissed: "AGENT_PRIVATE_QUESTION_WINDOW_MISSED",
});
