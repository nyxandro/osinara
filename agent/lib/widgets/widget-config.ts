/**
 * Fixed values of Telegram widgets: where their Bot API methods live and the limits every widget keeps.
 *
 * Exports:
 * - `TELEGRAM_WIDGETS_AVAILABLE`: whether the widget tools and rules reach the model at all.
 * - `TELEGRAM_WIDGET_API_BASE_URL`: the Bot API address of the widget methods.
 * - The widget limits, each named below.
 *
 * Key constructs:
 * - The widget methods of Bot API 10.4 are not published yet; on 06.11.2026 they answered only on
 *   Telegram's beta address, on the regular network, while the regular address returned 404. Only
 *   the widget methods go there: every other method stays on the regular address. When 10.4 is
 *   published the address becomes the regular one.
 * - Telegram refuses a widget over 32 768 bytes of HTML or 4096 bytes after zlib level 9; the
 *   compressed limit here keeps the margin Telegram's own tools keep, because Node's zlib and the
 *   server's PHP count a few dozen bytes apart and every refusal costs the model a new widget.
 */

export const TELEGRAM_WIDGETS_AVAILABLE = true;

export const TELEGRAM_WIDGET_API_BASE_URL = "https://api.telegram.org/beta";

export const WIDGET_HTML_MAX_BYTES = 32_768;
export const WIDGET_COMPRESSED_MAX_BYTES = 3_800;
/** Telegram's own limit, quoted in errors so the model sees how far over it is. */
export const TELEGRAM_WIDGET_COMPRESSED_LIMIT = 4_096;
/** `public_data` and `chat_data` of a widget, in UTF-8 bytes (Bot API 10.4 beta). */
export const WIDGET_PUBLIC_DATA_MAX_BYTES = 1_024;
/** A widget request's data, in bytes (Bot API 10.4 beta). */
export const WIDGET_QUERY_DATA_MAX_BYTES = 64;
export const WIDGET_CAPTION_MAX_LENGTH = 300;
export const WIDGET_HEIGHT_MIN = 50;
export const WIDGET_HEIGHT_MAX = 600;
/** Agent actions in one widget: each is a button whose press reaches the agent. */
export const WIDGET_ACTIONS_MAX = 8;
/** Local choice bits in one widget (checkboxes and options), all carried by a press in 64 bytes. */
export const WIDGET_CHOICE_BITS_MAX = 120;
/** Components in one described widget: Telegram stops a widget past 2000 nodes. */
export const WIDGET_COMPONENTS_MAX = 200;
