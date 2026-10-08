"use strict";

// No mutation capability, browser token reader or caller-defined send authority.
// Sending is private to the gated execution adapter's orchestrator.
const { openReadOnlyRuntimeSession } = require("./progress-live-fixture-adapter");
module.exports = { openFixtureRuntimeSession: openReadOnlyRuntimeSession };
