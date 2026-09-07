/** Native AI SDK inactivity policy, installed into Eve's ToolLoopAgent by the pinned patch. */
// Conservative initial window: the measured successful Qwen probes finished within 36 seconds,
// while some 90-second probes still produced reasoning. Activity must not be a total-time limit.
export const MODEL_INACTIVITY_TIMEOUT = Object.freeze({
  firstChunkMs: 5 * 60 * 1000,
  chunkMs: 5 * 60 * 1000,
});
