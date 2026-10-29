/**
 * The answer `remember` gives when a thread it was asked to create looks like an existing one.
 *
 * Exports:
 * - `memoryThreadCandidateRefusalResult`: the candidates and what to do next, instead of a failure.
 * - `MEMORY_THREAD_RETRY_EXHAUSTED_CODE`, `memoryThreadRetryExhaustedResult`: the answer once the one
 *   refined create is spent; an attach to a shown candidate is still accepted.
 *
 * As a thrown error the stop reached the model as a generic failure whose correction said not to
 * repeat the call, while the right next step is a call: attach to the matching thread, or one create
 * with a refined title. The backend allows exactly one refined create after a candidate stop and
 * refuses a third with `AGENT_MEMORY_THREAD_RETRY_EXHAUSTED`.
 */
import type { MemoryThreadCandidateError } from "./memory-thread-write.js";

export const MEMORY_THREAD_RETRY_EXHAUSTED_CODE = "AGENT_MEMORY_THREAD_RETRY_EXHAUSTED";

export function memoryThreadCandidateRefusalResult(refusal: MemoryThreadCandidateError) {
  return {
    candidates: refusal.candidates,
    code: refusal.code,
    correction: [
      "Запись не сохранена: похожая нить уже есть. Сравни названия нитей из списка с темой записи; если сомневаешься и read_memory_thread доступен, прочитай нить.",
      "Совпадает — повтори remember с thread.action=attach и threadRef из списка.",
      "Тема действительно другая — допустима одна повторная попытка create с однозначно уточнёнными названием и назначением; если снова придёт этот отказ, больше не создавай: прикрепи запись к подходящей нити из списка или скажи, что отдельную нить создать не удалось.",
      "О созданной или прикреплённой нити говори только после успешного remember.",
    ].join(" "),
    reason: "Похожая нить памяти уже существует.",
    saved: false,
  };
}

export function memoryThreadRetryExhaustedResult() {
  return {
    code: MEMORY_THREAD_RETRY_EXHAUSTED_CODE,
    correction: "Запись не сохранена: отдельную нить для этого сообщения создать не удалось, и create больше не пройдёт. Если одна из нитей прежнего отказа явно совпадает с темой, повтори remember с thread.action=attach и её threadRef; иначе скажи, что отдельную нить создать не удалось.",
    reason: "Уточнённая попытка создать нить уже израсходована.",
    saved: false,
  };
}
