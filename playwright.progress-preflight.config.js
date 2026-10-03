"use strict";

// Deterministic safety/readonly tests and specified regressions ONLY. Real LIVE execution uses the Node
// runner, never the default retain-on-failure Playwright configuration.
const base = require("./playwright.config");
module.exports = { ...base,
  testMatch: ["progress-live-preflight.spec.js", "progress-sync-cloud-service.spec.js",
    "progress-recovery-evidence.spec.js", "progress-account-switch-transition.spec.js",
    "favorite-product-auth.spec.js", "article-server-context-propagation.spec.js"], workers: 1, retries: 0,
  outputDir: "/tmp/lingoflow-progress-preflight-test-results",
  webServer: { ...base.webServer, stdout: "ignore", stderr: "ignore" },
  use: { ...base.use, trace: "off", video: "off", screenshot: "off" } };
