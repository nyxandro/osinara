/**
 * What the owner's private message is while an API key is awaited or was just awaited.
 *
 * Export:
 * - `classifyApiKeyMessage`: the key itself, a secret among other text, or an ordinary message.
 *
 * API keys are printable ASCII without spaces. A copy from a web page may carry invisible format
 * characters into the key; they are removed, because no key contains them. A long printable run
 * that mixes letters and digits inside other text may be a key, so such text is withheld rather
 * than sent to the model. Links, e-mail addresses and site names are not keys.
 */
export type ApiKeyMessage =
  | { readonly kind: "key"; readonly value: string }
  | { readonly kind: "ordinary" }
  | { readonly kind: "secret" };

const INVISIBLE = /\p{Cf}/gu;
const SINGLE_TOKEN = /^[\x21-\x7E]{16,4096}$/u;
const PRINTABLE_RUN = /[\x21-\x7E]{16,}/gu;
const LINK = /^[a-z][a-z0-9+.-]*:\/\//iu;
const EMAIL = /^[^@]+@[^@]+\.[a-z]{2,}$/iu;
const SITE_PATH = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/|$)/iu;

function isAddress(token: string): boolean {
  return LINK.test(token) || EMAIL.test(token) || SITE_PATH.test(token);
}

function mayBeKey(run: string): boolean {
  return !isAddress(run) && /[0-9]/u.test(run) && /[A-Za-z]/u.test(run);
}

export function classifyApiKeyMessage(text: string): ApiKeyMessage {
  const normalized = text.replace(INVISIBLE, "").trim();
  if (SINGLE_TOKEN.test(normalized) && !isAddress(normalized)) return { kind: "key", value: normalized };
  return (normalized.match(PRINTABLE_RUN) ?? []).some(mayBeKey) ? { kind: "secret" } : { kind: "ordinary" };
}
