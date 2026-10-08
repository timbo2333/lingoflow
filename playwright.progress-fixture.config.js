"use strict";

const base = require("./playwright.progress-preflight.config");
module.exports = { ...base, testMatch: ["progress-live-fixture.spec.js", "progress-live-fixture-adapter.spec.js", "progress-page-send-boundary.spec.js", "progress-live-fixture-hardening.spec.js", "progress-browser-context-network.spec.js", "progress-live-preflight.spec.js",
  "progress-sync-cloud-service.spec.js", "progress-recovery-evidence.spec.js", "progress-account-switch-transition.spec.js",
  "favorite-product-auth.spec.js", "article-server-context-propagation.spec.js", "progress-causal-state.spec.js",
  "progress-cloud-attempts.spec.js", "progress-local-desired.spec.js", "progress-fence.spec.js",
  "progress-syncdb-migration.spec.js"], metadata: { progressFixtureStrictNetwork: true },
  use: { ...base.use, launchOptions: { args: ["--remote-debugging-port=19993", "--remote-debugging-address=127.0.0.1"] } },
  outputDir: "/tmp/lingoflow-progress-fixture-test-results" };
