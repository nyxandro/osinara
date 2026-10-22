/**
 * The stop before a new record retires the current version of a property.
 *
 * Exports:
 * - `MemoryAttributeReplacementRefusal`: the stop, which is a product outcome and not a failure.
 * - `memoryAttributeReplacementRefusalResult`: what the model is answered with instead.
 *
 * A record with a property name (`attribute`) moves the subject's current record of the same name
 * into history, where neither the profile card nor the turn's memory selection sees it. The model
 * named properties far wider than one value at a time, and up to 21.10.2026 six of the twelve
 * replacements on production retired a fact that was still true: a past job retired the current
 * one under «место работы», and three links shared by three people under «resource» retired each
 * other. The model only ever saw the new text. Now it sees the version it is about to retire and
 * names it in `replaces`, or keeps both. A first version of a property is never stopped.
 */

export interface CurrentAttributeVersion {
  readonly content: string;
  readonly memoryRef: string;
}

/**
 * Not an error, however it travels: the model has to read what is stored before it retires it.
 * Thrown as its own class so the tool boundary can answer with it; the message carries the code
 * alone, because the versions are memory content and a message is what ends up in a log.
 */
export class MemoryAttributeReplacementRefusal extends Error {
  readonly code = "AGENT_MEMORY_ATTRIBUTE_REPLACEMENT_UNCONFIRMED";

  constructor(
    readonly attribute: string,
    readonly current: readonly CurrentAttributeVersion[],
  ) {
    super("AGENT_MEMORY_ATTRIBUTE_REPLACEMENT_UNCONFIRMED");
    this.name = "MemoryAttributeReplacementRefusal";
  }
}

export function memoryAttributeReplacementRefusalResult(refusal: MemoryAttributeReplacementRefusal) {
  return {
    code: refusal.code,
    correction: [
      `Запись не сохранена: под свойством «${refusal.attribute}» у этого субъекта уже есть действующая запись, и новая увела бы её в историю. Сравни тексты и выбери одно из трёх.`,
      "Новое значение того же свойства, а прежнее больше не верно (переехал, сменил работу) — повтори вызов с тем же attribute и перечисли в replaces все memoryRef из этого списка.",
      "Другой факт, который должен остаться рядом, — сохрани без attribute или под точным названием именно этого свойства.",
      "То же самое, что уже записано, — не сохраняй.",
    ].join(" "),
    current: refusal.current,
    reason: "Новая запись заменила бы действующую версию этого свойства.",
    saved: false,
  };
}
