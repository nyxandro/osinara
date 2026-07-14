/**
 * Fixed self-hosted Google OAuth callback channel.
 *
 * Export:
 * - Default Eve custom channel exposing only the exact Google callback GET route.
 */
import { defineChannel, GET } from "eve/channels";

import { handleGoogleOAuthCallback } from "../lib/google-workspace/google-oauth-callback.js";
import { GOOGLE_OAUTH_CALLBACK_PATH } from "../lib/google-workspace/google-workspace-config.js";

export default defineChannel({
  routes: [GET(GOOGLE_OAUTH_CALLBACK_PATH, handleGoogleOAuthCallback)],
});
