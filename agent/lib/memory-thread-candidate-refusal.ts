/**
 * The answer `remember` gives when a thread it was asked to create looks like an existing one.
 *
 * Export:
 * - `memoryThreadCandidateRefusalResult`: the candidates and what to do next, instead of a failure.
 *
 * As a thrown error the stop reached the model as a generic failure whose correction said not to
 * repeat the call, while the right next step is a call: attach to the matching thread, or one create
 * with a refined title. The backend allows exactly one refined create after a candidate stop and
 * refuses a third with `AGENT_MEMORY_THREAD_RETRY_EXHAUSTED`.
 */
import type { MemoryThreadCandidateError } from "./memory-thread-write.js";

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
