(function() {
  "use strict";

  // Copy this file to js/supabase-config.local.js for local Dev Cloud work.
  // The publishable key may be exposed in a browser. Never put a service-role
  // key, database password, or admin secret here.
  window.LingoFlowSupabaseDevConfig = Object.freeze({
    projectUrl: "https://YOUR_PROJECT_REF.supabase.co",
    publishableKey: "YOUR_SUPABASE_PUBLISHABLE_KEY",
    ownerId: "YOUR_SUPABASE_AUTH_USER_UUID",
    async getAccessToken() {
      // Supply the current signed-in user's short-lived JWT from the eventual
      // Auth/session boundary. Do not commit a token in this example file.
      throw new Error("Configure a Supabase Dev user access-token provider locally.");
    }
  });
})();
