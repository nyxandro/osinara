/**
 * Pointing «ты» at the assistant in a group's memory search.
 *
 * Export:
 * - `withAssistantName`: the search text with the assistant's name added when «ты» means it.
 *
 * In a group the assistant is asked about itself: «как ты выглядишь?», «кто тебя сделал?». The
 * chat's records about it are written with its name — «Аватар Осинары — колобок» — and the
 * address that carried the name is cut from the question before the search, on purpose (see
 * `memory-query-preparation.ts`). What is left, «как ты выглядишь», names nobody, and the record
 * is missed (#346). The name goes back in, at the end, only where «ты» can mean nobody else.
 *
 * Only in a group. In a private chat «ты» opens nearly every request — «ты можешь напомнить, где
 * ключи?» — and the name would pull the assistant's records over the keys.
 */
import { AGENT_DISPLAY_NAME, isAgentNameMentioned } from "./agent-name.js";

const SECOND_PERSON = /(?:^|[^\p{L}])(?:ты|тебя|тебе|тобой|тобою|твой|твоя|твое|твоё|твои|твоего|твоей|твоему|твоим|твоих|твоими|твою)(?=$|[^\p{L}])/iu;
// «Он сказал: ты неправ» — with a third person in the sentence «ты» may be quoted, not addressed.
const THIRD_PERSON = /(?:^|[^\p{L}])(?:он|она|оно|они|его|её|ее|ему|ей|им|ими|них|нему|ней|ним|нём|нем)(?=$|[^\p{L}])/iu;

export function withAssistantName(prepared: string): string {
  if (!SECOND_PERSON.test(prepared) || THIRD_PERSON.test(prepared)) return prepared;
  // Kept when the question already names it: «тебе нравится имя Осинара?» needs no second copy.
  if (isAgentNameMentioned(prepared)) return prepared;
  return `${prepared} ${AGENT_DISPLAY_NAME}`;
}
