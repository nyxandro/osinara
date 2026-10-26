# Mini Apps

**Load this when** building or reviewing a Mini App (Web App): launching it from the bot, signing the user in, theming, buttons, storage, device features, payments inside it. The client API (`Telegram.WebApp`) grows with almost every release — read `tgdocs.py page bots/webapps --toc` first, and its "Recent changes" section for what is new.

## Signing the user in — the part that must be right

The Mini App receives `initData` (a query string) from Telegram. `initDataUnsafe` is the same data **unverified** — never trust it for anything that matters.

1. The page sends the raw `initData` string to your server (for example in an `Authorization` header).
2. The server validates it (`page bots/webapps --section "Validating data received via the Mini App"`):
   - build the data-check-string: every received field except `hash`, as `key=value`, sorted alphabetically, joined with a line feed;
   - the secret key is the HMAC-SHA-256 of the bot token keyed with the constant string `WebAppData`;
   - the expected `hash` is the hex HMAC-SHA-256 of the data-check-string with that secret key; compare in constant time.
3. Check `auth_date` is recent; how recent is your product decision (minutes to an hour), but there must be a bound, or a leaked `initData` works forever.
4. Then issue your own short-lived session; do not re-send `initData` on every request for ever.

A **third party** that does not hold the bot token can validate with the Ed25519 `signature` field and Telegram's public key (same section). Prefer a maintained library for either check, but test it against the docs' algorithm — and validate on the server, never in the page.

## Launching

A Mini App can open from a keyboard button, an inline button, the menu button, the bot's main Mini App (profile and direct link), inline mode, a direct link with `startapp`, the attachment menu, or a chat join request. Each delivers different data and allows different follow-ups — for example, only some launch modes can send data back to the bot, and inline-mode Mini Apps answer through `answerWebAppQuery`. Read the "Implementing Mini Apps" subsections for the launch mode you use.

## Security of the page itself

- Mini App methods are restricted to the Mini App's original domain (a protection Telegram enabled by default; it can be turned off in BotFather, which makes keeping the app free of links to untrusted sites your responsibility). Do not load your app through redirects or third-party origins.
- The bot token never goes to the page. Anything the page needs from the Bot API goes through your server.
- Treat everything the page sends (form data, `sendData`, query params, `start_param`) as user input.
- Payments inside a Mini App follow the bot's rules (`payments-stars.md`); delivery happens on the bot's `successful_payment`, never on the page's word.

## Look and feel

- Follow the client's theme: `colorScheme` (light/dark) and `themeParams` colors, updated on the `themeChanged` event; respect safe-area insets (notches, Telegram's own header) — sections "Color Schemes", "SafeAreaInset", "ContentSafeAreaInset".
- Use Telegram's native controls where they exist (BackButton, BottomButton/main button, SettingsButton, popups, haptic feedback) instead of imitating them in HTML; never imitate Telegram's own interface or system alerts (also a developer-terms rule).
- Full-screen mode, home-screen shortcuts, loading screens, emoji status, story sharing, geolocation and motion sensors exist — each needs a user action or permission; check the section and the minimum client version before relying on one.
- Design for small phones first, both themes, and slow networks; `ready()` as soon as the first screen is usable.

## Storage and state

- Telegram offers `CloudStorage` (small key-value data per user and bot), `DeviceStorage` and `SecureStorage` (on the device). Read their limits in the page before choosing; your server database remains the source of truth for anything important.

## Testing

- The test environment allows plain HTTP links for Mini Apps; production requires HTTPS (`page bots/features --section "Testing your bot"`).
- Test inside real Telegram clients (mobile and desktop) in both themes; a desktop browser is not the same runtime.
