/**
 * Fixed self-hosted Google OAuth callback channel.
 *
 * Export:
 * - Default Eve custom channel exposing only the exact Google callback GET route.
 */
import { defineChannel, GET } from "eve/channels";

import { GOOGLE_OAUTH_CALLBACK_PATH } from "../lib/google-calendar/google-calendar-config.js";
import { handleGoogleOAuthCallback } from "../lib/google-calendar/google-oauth-callback.js";

export default defineChannel({
  routes: [GET(GOOGLE_OAUTH_CALLBACK_PATH, handleGoogleOAuthCallback)],
});
