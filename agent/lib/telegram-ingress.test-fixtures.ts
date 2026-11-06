/** Shared settings for durable-ingress tests. */

/** Claims at once and one message at a time: for tests of behavior other than private-chat bursts. */
export const NO_BURSTS = { maxCharacters: 1, maxMessages: 1, maxWaitMilliseconds: 0, quietMilliseconds: 0 } as const;

/** No update is a private question (`/me`, #467): for tests of the group and private-chat paths. */
export const NO_PRIVATE_QUESTIONS = Object.freeze({
  arrive: async () => undefined,
  fail: async () => undefined,
  isPrivate: () => false,
  process: async () => null,
  queueKey: () => {
    throw new Error("AGENT_TEST_PRIVATE_QUESTION_UNEXPECTED: an update was treated as a private question");
  },
});
