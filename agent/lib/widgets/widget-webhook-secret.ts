/**
 * The webhook secret of Telegram's beta server, which delivers only widget presses.
 *
 * Export:
 * - `widgetWebhookSecret`: the secret, derived from the main webhook secret.
 *
 * Key construct:
 * - Derived, not configured: the beta server needs a secret of its own so the webhook can tell its
 *   deliveries apart (it takes only presses from it), and a second environment value would only be
 *   something to forget on a server. HMAC keeps it unguessable without the main secret; the result is
 *   base64url, within the characters Telegram accepts for `secret_token`.
 */
import { createHmac } from "node:crypto";

const DERIVATION_LABEL = "osinara:telegram-widget-beta-webhook:1";

export function widgetWebhookSecret(mainSecret: string): string {
  if (mainSecret === "") throw new Error("AGENT_TELEGRAM_WEBHOOK_SECRET_MISSING: the main webhook secret is required to derive the widget one");
  return createHmac("sha256", mainSecret).update(DERIVATION_LABEL).digest("base64url");
}
