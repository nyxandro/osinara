/** Shared settings for durable-ingress tests. */

/** Claims at once and one message at a time: for tests of behavior other than private-chat bursts. */
export const NO_BURSTS = { maxCharacters: 1, maxMessages: 1, maxWaitMilliseconds: 0, quietMilliseconds: 0 } as const;
