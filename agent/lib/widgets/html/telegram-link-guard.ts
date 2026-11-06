/**
 * The script put before the model's own HTML that keeps the widget from opening Telegram links.
 *
 * Exports:
 * - `TELEGRAM_LINK_GUARD`: the `<script>` that runs first in the widget.
 * - `withTelegramLinkGuard`: the HTML with the guard in front.
 *
 * Key constructs:
 * - `openTelegramLink` opens a t.me link inside Telegram without a confirmation, so a page that talked the
 *   model into building such a link — even out of pieces the quick check cannot read — could start a bot
 *   or join a chat behind a harmless button. The guard runs before the widget's own script: it replaces
 *   `openTelegramLink` with nothing, lets `openLink` open only web pages outside Telegram (Telegram shows
 *   their address and asks), and fixes both so the widget's code cannot put the originals back.
 * - A tapped link to Telegram is cancelled the same way, in the capture phase, before the widget sees it.
 * - Checked in Telegram's harness on 06.11.2026: `TelegramWidget` is not frozen and its methods can be
 *   replaced. What a client does with a cancelled tap on a link is not verified.
 */

export const TELEGRAM_LINK_GUARD = "<script>(()=>{const W=window.TelegramWidget;if(!W)return;"
  + "const t=u=>{try{const h=new URL(String(u),'https://x.invalid').hostname.toLowerCase().replace(/\\.$/,'');"
  + "return /^tg:/i.test(String(u))||/(^|\\.)(t\\.me|telegram\\.(me|dog|org))$/.test(h)}catch(e){return true}},o=W.openLink;"
  + "Object.defineProperty(W,'openTelegramLink',{value:()=>{},writable:false,configurable:false});"
  + "Object.defineProperty(W,'openLink',{value:u=>{if(!t(u))o.call(W,u)},writable:false,configurable:false});"
  + "document.addEventListener('click',e=>{const a=e.target&&e.target.closest&&e.target.closest('a[href]');if(a&&t(a.getAttribute('href'))){e.preventDefault();e.stopPropagation()}},true)})()</script>";

export function withTelegramLinkGuard(html: string): string {
  return `${TELEGRAM_LINK_GUARD}${html}`;
}
