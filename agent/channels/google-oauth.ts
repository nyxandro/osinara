/**
 * Fixed self-hosted Google OAuth callback route.
 *
 * Export:
 * - `googleOAuthRoutes`: only the exact Google callback GET route.
 */
import type { RuntimeRoute } from "../runtime/server.js";
import { handleGoogleOAuthCallback } from "../lib/google-workspace/google-oauth-callback.js";
import { GOOGLE_OAUTH_CALLBACK_PATH } from "../lib/google-workspace/google-workspace-config.js";

export function googleOAuthRoutes(): RuntimeRoute[] {
  return [{ handle: (request) => handleGoogleOAuthCallback(request), method: "GET", path: GOOGLE_OAUTH_CALLBACK_PATH }];
}
