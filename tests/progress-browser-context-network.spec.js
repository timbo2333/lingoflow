"use strict";

const { test, expect, chromium } = require("./progress-strict-test");
const { EventEmitter } = require("node:events");
const network = require("./progress-forbidden-network");
const endpoints = [
  ["Article REST", "https://yebabpjplbgidzwpjhoy.supabase.co/rest/v1/article_sync_records"],
  ["Progress RPC", "https://yebabpjplbgidzwpjhoy.supabase.co/rest/v1/rpc/lingoflow_progress_sync_push"],
  ["Auth", "https://yebabpjplbgidzwpjhoy.supabase.co/auth/v1/user"],
  ["other host", "https://network-guard.invalid/blocked"]
];

// Independent RED-test safety only: no external request can leave the browser,
// including before the central infrastructure is fixed. It does NOT count for
// or install the central detector under review.
async function safeProbePage(context) {
  const page = await context.newPage();
  let attempts = 0, aborted = 0;
  context.on("request", req => { if (!network.local(req.url())) attempts++; });
  await page.route("**/*", route => {
    if (network.local(route.request().url())) return route.fallback();
    aborted++; return route.abort();
  });
  await page.goto("http://127.0.0.1:4173/favicon.svg");
  return { page, counts: () => ({ attempts, aborted }) };
}
async function forbidden(page, endpoint) {
  await page.evaluate(async endpoint => { try { await fetch(endpoint); } catch { /* intentionally blocked */ } }, endpoint);
}

for (const [name, endpoint] of endpoints) test(`manual context ${name}: central teardown fails even after independent abort`, async ({ browser, context }) => {
  let counts;
  await expect(network.runStrictNetworkCase(context, async () => {
    const manual = await browser.newContext();
    try {
      const probe = await safeProbePage(manual);
      await forbidden(probe.page, endpoint); counts = probe.counts();
    } finally { await manual.close(); }
  })).rejects.toThrow("Forbidden network attempt count: 1");
  expect(counts).toEqual({ attempts: 1, aborted: 1 });
});

test("two manual contexts share accounting, including after both close", async ({ browser, context }) => {
  let counts;
  await expect(network.runStrictNetworkCase(context, async () => {
    const a = await browser.newContext(), b = await browser.newContext();
    try {
      const one = await safeProbePage(a), two = await safeProbePage(b);
      await forbidden(one.page, endpoints[0][1]); await forbidden(two.page, endpoints[3][1]);
      counts = [one.counts(), two.counts()];
    } finally { await a.close(); await b.close(); }
  })).rejects.toThrow("Forbidden network attempt count: 2");
  expect(counts).toEqual([{ attempts: 1, aborted: 1 }, { attempts: 1, aborted: 1 }]);
});

test("migration-style manual context receives MOCK config before Home startup", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4173" }), page = await context.newPage();
  let attempts = 0;
  context.on("request", req => { if (!network.local(req.url())) attempts++; });
  await page.route("**/*", route => network.local(route.request().url()) ? route.fallback() : route.abort());
  try {
    await page.goto("/");
    const state = await page.evaluate(async () => {
      const db = await LingoFlowSyncStateRepository.openDatabase();
      return { project: LingoFlowSupabaseConfig.projectUrl,
        keyPath: db.transaction("progressCloudAttempts").objectStore("progressCloudAttempts").keyPath };
    });
    expect(state.project).toBe("https://mock.invalid");
    expect(state.keyPath).toEqual(["ownerId", "bindingId", "articleId", "attemptId"]);
    expect(attempts).toBe(0);
  } finally { await context.close(); }
});

for (const kind of ["default", "manual"]) test(`${kind} context: central route alone aborts and teardown fails`, async ({ browser, context }) => {
  let failed = false;
  await expect(network.runStrictNetworkCase(context, async () => {
    const target = kind === "default" ? context : await browser.newContext();
    const page = await target.newPage();
    page.on("requestfailed", request => { if (!network.local(request.url())) failed = true; });
    await page.goto("http://127.0.0.1:4173/favicon.svg");
    await forbidden(page, endpoints[3][1]);
    if (kind === "manual") await target.close(); else await page.close();
  })).rejects.toThrow("Forbidden network attempt count: 1");
  expect(failed).toBe(true);
});

test("future page and popup inherit the context-level detector", async ({ browser, context }) => {
  let failures = 0;
  await expect(network.runStrictNetworkCase(context, async () => {
    const manual = await browser.newContext();
    manual.on("requestfailed", request => { if (!network.local(request.url())) failures++; });
    try {
      const page = await manual.newPage();
      await page.goto("http://127.0.0.1:4173/favicon.svg");
      const pending = page.waitForEvent("popup");
      await page.evaluate(() => { window.open("/favicon.svg"); });
      const popup = await pending; await popup.waitForLoadState();
      await forbidden(page, endpoints[3][1]); await forbidden(popup, endpoints[3][1]);
    } finally { await manual.close(); }
  })).rejects.toThrow("Forbidden network attempt count: 2");
  expect(failures).toBe(2);
});

test("repeated context/page installation is idempotent and counts once", async ({ browser, context }) => {
  await expect(network.runStrictNetworkCase(context, async () => {
    const wrapped = browser.newContext, manual = await browser.newContext();
    const listeners = manual.listeners("request").length;
    const originalRoute = manual.route; let extraRoutes = 0;
    manual.route = async function(...args) { extraRoutes++; return originalRoute.apply(this, args); };
    try {
      await network.runStrictNetworkCase(manual, async () => {
        expect(browser.newContext).toBe(wrapped);
        expect(manual.listeners("request")).toHaveLength(listeners);
      });
      const page = await manual.newPage();
      await network.installForbiddenNetwork(page); await network.installForbiddenNetwork(page);
      expect(extraRoutes).toBe(0);
      expect(manual.listeners("request")).toHaveLength(listeners);
      await page.goto("http://127.0.0.1:4173/favicon.svg");
      await forbidden(page, endpoints[3][1]);
      expect(page.forbiddenNetworkAttempts).toHaveLength(1);
    } finally { manual.route = originalRoute; await manual.close(); }
  })).rejects.toThrow("Forbidden network attempt count: 1");
});

test("real manual context preserves caller options and native close behavior", async ({ browser }) => {
  const before = browser.contexts().length;
  const options = { viewport: { width: 390, height: 777 }, locale: "de-DE", timezoneId: "UTC",
    colorScheme: "dark", permissions: [], serviceWorkers: "allow",
    storageState: { cookies: [], origins: [{ origin: "http://127.0.0.1:4173",
      localStorage: [{ name: "guard-options-marker", value: "preserved" }] }] } };
  const snapshot = structuredClone(options), context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:4173/favicon.svg");
  expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, language: navigator.language,
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone, dark: matchMedia("(prefers-color-scheme: dark)").matches,
    marker: localStorage.getItem("guard-options-marker") }))).toEqual({
    width: 390, height: 777, language: "de-DE", zone: "UTC", dark: true, marker: "preserved"
  });
  expect(options).toEqual(snapshot);
  await context.close(); expect(page.isClosed()).toBe(true);
  expect(browser.contexts()).toHaveLength(before);
});

for (const kind of ["launch", "persistent"]) test(`independent strict ${kind} is protected before return`, async ({ context }) => {
  await expect(network.runStrictNetworkCase(context, async () => {
    let independent, manual;
    // Do not inherit the fixture's fixed CDP port (19993): simultaneous native
    // launches contend for it before returning any browser/context to guard.
    // These probes do not use CDP; leave native Playwright transport selection.
    const launchOptions = { headless: true, args: [] };
    if (kind === "launch") {
      independent = await test.step("native launch + automatic browser guard", () => chromium.launch(launchOptions));
      manual = await test.step("native context creation + automatic context guard", () => independent.newContext());
    } else manual = await test.step("native persistent launch + automatic context guard", () => chromium.launchPersistentContext("", launchOptions));
    try {
      const probe = await test.step("create local page", () => safeProbePage(manual));
      await test.step("abort and count external probe", () => forbidden(probe.page, endpoints[3][1]));
      expect(probe.counts()).toEqual({ attempts: 1, aborted: 1 });
    } finally { await test.step("native close", () => independent ? independent.close() : manual.close()); }
  })).rejects.toThrow("Forbidden network attempt count: 1");
});

// Structural lifecycle probes have no HTTP adapter and cannot perform IO.
function fakeBrowser() {
  const all = [];
  const browser = {
    closeCount: 0,
    contexts: () => all.filter(context => !context.closed),
    async close() { this.closeCount++; for (const context of this.contexts()) await context.close(); },
    async newContext(options = {}) {
      if (this !== browser) throw new Error("this binding lost");
      if (options.creationError) throw options.creationError;
      if (options.delay) await options.delay;
      const context = new EventEmitter();
      Object.assign(context, { options, closed: false, closeCount: 0, routes: [],
        browser: () => browser, addInitScript: async () => { options.onInitialize?.(); if (options.initializationDelay) await options.initializationDelay; },
        async route(pattern, handler) {
          if (options.installationError && pattern.includes("supabase-config")) throw options.installationError;
          this.routes.push({ pattern, handler });
        },
        async unroute(pattern, handler) { this.routes = this.routes.filter(route => route.pattern !== pattern || route.handler !== handler); },
        async close() { this.closed = true; this.closeCount++; this.emit("close"); }
      });
      all.push(context); return context;
    }
  };
  return { browser, all };
}
function emitForbidden(context) { context.emit("request", { url: () => endpoints[3][1] }); }

test("existing contexts are guarded once and subsequent cases have fresh accounting", async () => {
  const { browser } = fakeBrowser(), original = browser.newContext;
  const one = await browser.newContext(), two = await browser.newContext();
  await expect(network.runStrictNetworkCase(one, async () => {
    expect(one.listenerCount("request")).toBe(1); expect(two.listenerCount("request")).toBe(1);
    emitForbidden(two);
  }, browser)).rejects.toThrow("Forbidden network attempt count: 1");
  expect(browser.newContext).toBe(original);
  for (const context of [one, two]) { expect(context.listenerCount("request")).toBe(0); expect(context.routes).toHaveLength(0); }
  expect(await network.runStrictNetworkCase(one, async () => "clean", browser)).toBe("clean");
  expect(browser.newContext).toBe(original);
});

test("wrapper preserves options/this/errors and unwinds partial guard installation", async () => {
  const { browser, all } = fakeBrowser(), original = browser.newContext, initial = await browser.newContext();
  const options = { recordVideo: { dir: "/tmp/unused-mock" }, proxy: { server: "mock-only" },
    permissions: ["clipboard-read"], serviceWorkers: "allow", storageState: { cookies: [], origins: [] } };
  const creationError = new Error("native creation failure"), installationError = new Error("guard installation failure");
  await network.runStrictNetworkCase(initial, async () => {
    const created = await browser.newContext(options); expect(created.options).toBe(options); await created.close();
    await expect(browser.newContext({ creationError })).rejects.toBe(creationError);
    await expect(browser.newContext({ installationError })).rejects.toBe(installationError);
    const partial = all.at(-1); expect(partial.closeCount).toBe(1);
    expect(partial.listenerCount("request")).toBe(0); expect(partial.routes).toHaveLength(0);
  }, browser);
  expect(browser.newContext).toBe(original); expect(initial.listenerCount("request")).toBe(0);
});

test("body failure and network failure are both preserved, then wrapper restores", async () => {
  const { browser } = fakeBrowser(), original = browser.newContext, context = await browser.newContext();
  const assertion = new Error("original assertion failure");
  let failure;
  try { await network.runStrictNetworkCase(context, async () => { emitForbidden(context); throw assertion; }, browser); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors[0]).toBe(assertion);
  expect(failure.errors[1].message).toBe("Forbidden network attempt count: 1");
  expect(browser.newContext).toBe(original);
  await expect(network.runStrictNetworkCase(context, async () => { throw assertion; }, browser)).rejects.toBe(assertion);
});

test("concurrent helper scopes on separate browsers do not cross-count", async () => {
  const a = fakeBrowser(), b = fakeBrowser();
  const ca = await a.browser.newContext(), cb = await b.browser.newContext();
  let release; const barrier = new Promise(resolve => { release = resolve; });
  const run = (context, browser) => network.runStrictNetworkCase(context, async () => {
    const child = await browser.newContext(); await barrier; emitForbidden(child); await child.close();
  }, browser);
  const first = run(ca, a.browser), second = run(cb, b.browser);
  release();
  const results = await Promise.allSettled([first, second]);
  expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
  expect(results.map(result => result.reason.message)).toEqual([
    "Forbidden network attempt count: 1", "Forbidden network attempt count: 1"
  ]);
});

test("context creation resolving after teardown is rejected and closed", async () => {
  const { browser, all } = fakeBrowser(), original = browser.newContext, context = await browser.newContext();
  let release, late; const delay = new Promise(resolve => { release = resolve; });
  await network.runStrictNetworkCase(context, async () => { late = browser.newContext({ delay }); }, browser);
  expect(browser.newContext).toBe(original);
  release(); await expect(late).rejects.toThrow("Strict network scope is closed");
  expect(all.at(-1).closeCount).toBe(1); expect(all.at(-1).listenerCount("request")).toBe(0);
});

test("guard installation completing after teardown cannot return a half-guarded context", async () => {
  const { browser, all } = fakeBrowser(), original = browser.newContext, context = await browser.newContext();
  let release, started, late;
  const initializationDelay = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  await network.runStrictNetworkCase(context, async () => {
    late = browser.newContext({ initializationDelay, onInitialize: started });
    await entered;
  }, browser);
  release(); await expect(late).rejects.toThrow("Strict network scope is closed");
  const partial = all.at(-1);
  expect(partial.closeCount).toBe(1); expect(partial.listenerCount("request")).toBe(0);
  expect(partial.routes).toHaveLength(0); expect(browser.newContext).toBe(original);
});

test("independent launch completing after teardown is closed without leaking a wrapper", async () => {
  const base = fakeBrowser(), fresh = fakeBrowser(), initial = await base.browser.newContext();
  const original = fresh.browser.newContext;
  let release, late; const delay = new Promise(resolve => { release = resolve; });
  const type = network.strictBrowserType({ async launch() { await delay; return fresh.browser; } });
  await network.runStrictNetworkCase(initial, async () => { late = type.launch(); }, base.browser);
  release(); await expect(late).rejects.toThrow("Strict network scope is closed");
  expect(fresh.browser.closeCount).toBe(1); expect(fresh.browser.newContext).toBe(original);
});
