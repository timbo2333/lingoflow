"use strict";

const base = require("@playwright/test");
const network = require("./progress-forbidden-network");
const test = base.test.extend({
  _fixtureNetworkSafety: [async ({ browser, context }, use, testInfo) => {
    if (!testInfo.config.metadata?.progressFixtureStrictNetwork) return use();
    await network.runStrictNetworkCase(context, use, browser);
  }, { auto: true }]
});
module.exports = { ...base, test,
  chromium: network.strictBrowserType(base.chromium),
  firefox: network.strictBrowserType(base.firefox),
  webkit: network.strictBrowserType(base.webkit) };
