"use strict";

// Isolated, mock-only tooling tests. Lifecycle notifications are deliberately
// withheld to reproduce the cross-CDP ordering gap, not to change production.
const { test, expect, chromium } = require("./progress-strict-test");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = readFileSync(path.join(__dirname, "progress-live-runtime-inspector.js"), "utf8");
const runtimeURL = "http://127.0.0.1:4173/__invalidation_fixture";
const scope = { ownerId: "mock-owner", articleId: "mock-article" };
const validScope = () => ({ status: "ready", ownerId: scope.ownerId, bindingId: "mock-binding",
  generation: 3, scopeToken: "mock-scope", stable: true, transitionInactive: true });
const fingerprint = "sha256:" + "a".repeat(64);
const epoch = "11111111-2222-4333-8444-555555555555";
const validRuntime = () => ({ ...validScope(), scopeValid: true, fencePresent: true, articleId: scope.articleId,
  articleActive: true, contentFingerprint: fingerprint, contentBytes: 2048,
  parent: { articleRevision: "revision:1", readingEpoch: epoch, contentFingerprint: fingerprint, lifecycle: "active" },
  bootstrapSafe: true, hasConflict: false, hasMutation: false, pendingMovement: false, quarantinedMovement: false,
  unsettledAttempts: false, observationDiagnostic: false,
  observation: { kind: "revision", revision: "revision:2", cursor: "cursor:2", parentReadingEpoch: epoch,
    contentFingerprint: fingerprint, checkpoint: { progress: 0.2, paragraphIndex: 2 } },
  reader: { articleId: scope.articleId, baselineArticleId: scope.articleId, baselineFingerprint: fingerprint,
    baseline: { progress: 0.2, paragraphIndex: 2 }, pendingSave: false, startY: 0, scrollRange: 2000,
    anchorOffset: 200, currentScrollY: 400, maxScrollY: 2000, paragraphs: [{ index: 3, top: 1000 }] } });

function inspectorWithBrowser(browser) {
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, URL, setTimeout, clearTimeout,
    require: name => name === "playwright"
      ? { chromium: { connectOverCDP: async () => browser } } : require(name) });
  return module.exports;
}

function mockSession(evaluate) {
  const page = new EventEmitter();
  const frame = {};
  page.mainFrame = () => frame;
  page.url = () => runtimeURL;
  page.evaluate = evaluate;
  const browser = { contexts: () => [{ pages: () => [page] }], close: async () => {} };
  return { page, open: () => inspectorWithBrowser(browser).openRuntimeSession(scope,
    { cdpURL: "http://127.0.0.1:19991/", runtimeURL }) };
}

for (const [label, failure] of [
  ["normal JS TypeError", new TypeError("page.evaluate: TypeError: mock guard failed")],
  ["unexpected serialization error", new Error("page.evaluate: Object could not be cloned")],
  ["IndexedDB exception", new Error("page.evaluate: InvalidStateError: database closed")],
  ["similar text from page script", new Error("page.evaluate: TypeError: Execution context was destroyed")],
  ["unexpected protocol error", new Error("page.evaluate: Protocol error (Runtime.callFunctionOn): unknown failure")]
]) {
  test(`runtime invalidation does not swallow ${label}`, async () => {
    const fixture = mockSession(async () => { throw failure; });
    const session = await fixture.open();
    try {
      // vm-created promises are cross-realm; assert the preserved error object
      // directly rather than relying on a matcher recognizing its Promise type.
      const caught = await session.captureScope().then(() => null, error => error);
      expect(caught).toBe(failure);
    }
    finally { await session.close(); }
  });
}

test("runtime without navigation preserves the same normal scope", async () => {
  let calls = 0;
  const fixture = mockSession(async () => { calls++; return validScope(); });
  const session = await fixture.open();
  try {
    const first = await session.captureScope();
    expect(first.status).toBe("ready");
    expect(await session.captureScope()).toEqual(first);
    expect(calls).toBe(2);
  } finally { await session.close(); }
});

for (const failure of ["TypeError", "IndexedDB read failure"]) {
  test(`[P2 contract] real evaluator ${failure} rejects instead of unavailable`, async ({ page }) => {
    await page.route("**/__invalidation_fixture", route => route.fulfill({
      contentType: "text/html", body: "<!doctype html><title>Mock evaluator only</title>" }));
    await page.goto(runtimeURL);
    await page.evaluate(failure => {
      if (failure === "TypeError") {
        Object.defineProperty(window, "LingoFlowSyncStateRepository", {
          get() { throw new TypeError("mock runtime guard failure"); } });
      } else {
        // The real evaluator invokes this browser-side IDB read seam. No DB,
        // Article, Auth session or credential is created/read by this fixture.
        for (const name of ["LingoFlowSyncStateRepository", "LingoFlowArticleLibrary",
          "LingoFlowProgressLocalDesired", "LingoFlowProgressCausalState", "LingoFlowSupabaseAuth"]) window[name] = {};
        IDBFactory.prototype.databases = async function() {
          throw new DOMException("mock database read failure", "InvalidStateError");
        };
      }
    }, failure);
    const browser = { contexts: () => [{ pages: () => [page] }], close: async () => {} };
    const session = await inspectorWithBrowser(browser).openRuntimeSession(scope,
      { cdpURL: "http://127.0.0.1:19991/", runtimeURL });
    try {
      // Real Page.evaluate and the actual inspectExistingRuntime callback.
      // Only the connection lookup is injected; the evaluator is not replaced.
      const caught = await session.captureScope().then(() => null, error => error);
      expect(caught).not.toBeNull();
      expect(caught.message).toContain(failure === "TypeError"
        ? "TypeError: mock runtime guard failure" : "InvalidStateError: mock database read failure");
    } finally { await session.close(); }
  });
}

for (const [label, mutate] of [
  ["missing full-runtime flag", value => { delete value.hasConflict; }],
  ["wrong full-runtime flag type", value => { value.bootstrapSafe = "true"; }],
  ["missing parent revision", value => { delete value.parent.articleRevision; }],
  ["illegal parent lifecycle", value => { value.parent.lifecycle = "unknown"; }],
  ["invalid observation kind", value => { value.observation.kind = "unknown-enum"; }],
  ["missing observation checkpoint", value => { delete value.observation.checkpoint; }],
  ["wrong checkpoint type", value => { value.observation.checkpoint.progress = "0.2"; }],
  ["invalid reader baseline", value => { value.reader.baseline.paragraphIndex = -1; }],
  ["invalid reader paragraphs", value => { value.reader.paragraphs = {}; }],
  ["invalid paragraph geometry", value => { value.reader.paragraphs[0].top = Infinity; }]
]) {
  test(`[P2 contract] malformed full inspection ${label} throws before consumers`, async () => {
    const value = validRuntime(); mutate(value);
    const fixture = mockSession(async () => value);
    const session = await fixture.open();
    try {
      const caught = await session.inspectRuntime().then(() => null, error => error);
      expect(caught).not.toBeNull();
      expect(caught.message).toMatch(/^invalid runtime inspection result/);
      expect(caught.message).not.toContain(fingerprint);
    } finally { await session.close(); }
  });
}

test("runtime inspection refuses accessor fields without executing them", async () => {
  const value = validScope(); let reads = 0;
  Object.defineProperty(value, "ownerId", { get() { reads++; throw new Error("mock private-value trap"); } });
  const fixture = mockSession(async () => value);
  const session = await fixture.open();
  try {
    const caught = await session.captureScope().then(() => null, error => error);
    expect(caught.message).toBe("invalid runtime inspection result: ownerId");
    expect(reads).toBe(0);
  } finally { await session.close(); }
});

for (const [label, patch] of [
  ["full reader and revision", {}],
  ["nullable facts", { parent: null, observation: null, reader: null }],
  ["unknown observation", { observation: { kind: "unknown" }, reader: null }],
  ["absent observation", { observation: { kind: "absent", evidence: {
    kind: "completed-inventory-catchup", highWaterCursor: "cursor:2", throughCursor: "cursor:2" } }, reader: null }],
  ["valid but not ready facts", { stable: false, scopeValid: false, bootstrapSafe: false }]
]) {
  test(`runtime inspection preserves structured ${label} without making a readiness decision`, async () => {
    const value = { ...validRuntime(), ...patch };
    const fixture = mockSession(async (_callback, args) => args.scopeOnly ? validScope() : value);
    const session = await fixture.open();
    try {
      const baseline = await session.captureScope();
      const inspected = await session.inspectRuntime();
      expect(inspected).toEqual({ ...value, runtimeIdentity: baseline.runtimeIdentity });
      expect(await session.captureScope()).toEqual(baseline);
    } finally { await session.close(); }
  });
}

test("runtime inspection preserves explicit unavailable and invalidation takes precedence over shape validation", async () => {
  let calls = 0;
  const fixture = mockSession(async () => {
    calls++;
    if (calls === 1) return { status: "unavailable", reason: "local-binding-unresolved" };
    fixture.page.emit("framenavigated", fixture.page.mainFrame());
    return null;
  });
  const session = await fixture.open();
  try {
    expect(await session.captureScope()).toMatchObject({ status: "unavailable", reason: "local-binding-unresolved" });
    expect(await session.captureScope()).toEqual({ status: "unavailable" });
    expect(await session.inspectRuntime()).toEqual({ status: "unavailable" });
    expect(calls).toBe(2);
  } finally { await session.close(); }
});

for (const [label, value] of [
  ["null", null], ["array", []], ["string", "mock-invalid"], ["empty object", {}],
  ["illegal status", { status: "unknown" }],
  ["missing owner", { ...validScope(), ownerId: undefined }],
  ["wrong generation type", { ...validScope(), generation: "3" }],
  ["wrong stable type", { ...validScope(), stable: "true" }]
]) {
  test(`[P2 contract] malformed inspection ${label} throws at inspector boundary`, async () => {
    let calls = 0;
    const fixture = mockSession(async () => ++calls === 1 ? value : validScope());
    const session = await fixture.open();
    try {
      const caught = await session.captureScope().then(() => null, error => error);
      expect(caught).not.toBeNull();
      expect(caught.message).toMatch(/^invalid runtime inspection result/);
      expect(caught.message).not.toContain("mock-invalid");
      // Malformed data must fail, not masquerade as Document invalidation.
      expect((await session.captureScope()).status).toBe("ready");
      expect(calls).toBe(2);
    } finally { await session.close(); }
  });
}

test("actual page JavaScript TypeError is not classified as Document loss", async ({ page }) => {
  await page.route("**/__invalidation_fixture", route => route.fulfill({
    contentType: "text/html", body: "<!doctype html><title>Mock only</title>" }));
  await page.goto(runtimeURL);
  let original;
  const fixture = mockSession(async () => {
    try { return await page.evaluate(() => { throw new TypeError("mock guard invariant failure"); }); }
    catch (error) { original = error; throw error; }
  });
  const session = await fixture.open();
  try {
    const caught = await session.captureScope().then(() => null, error => error);
    expect(caught).not.toBeNull();
    expect(caught).toBe(original);
    expect(caught.message).toContain("page.evaluate: TypeError: mock guard invariant failure");
  } finally { await session.close(); }
});

for (const action of ["navigation", "same URL reload", "page close", "target detach"]) {
  test(`actual Chromium ${action} before invalidation notification settles unavailable permanently`, async () => {
    const net = require("node:net").createServer();
    const port = await new Promise((resolve, reject) => {
      net.on("error", reject);
      net.listen(0, "127.0.0.1", () => { const port = net.address().port; net.close(() => resolve(port)); });
    });
    const context = await chromium.launchPersistentContext("", { headless: true,
      args: [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"] });
    let attached, session;
    try {
      const control = context.pages()[0];
      await control.route("**/__invalidation*", route => route.fulfill({
        contentType: "text/html", body: "<!doctype html><title>Mock document only</title>" }));
      await control.goto(runtimeURL);
      attached = await chromium.connectOverCDP(`http://127.0.0.1:${port}/`, { noDefaults: true });
      const page = attached.contexts()[0].pages()[0];
      const observedErrors = [];
      let evaluations = 0, notifications = 0;
      const delayedPage = new Proxy(page, { get(target, name) {
        // Hold only the inspector's lifecycle notifications. Browser navigation
        // and page.evaluate still use real independent CDP connections.
        if (name === "on" || name === "off") return () => { notifications++; };
        if (name === "evaluate") return async () => {
          evaluations++;
          try { return await target.evaluate(async () => {
            window.__invalidationEvaluationStarted = true;
            await new Promise(() => {});
          }); } catch (error) {
            observedErrors.push({ name: error.name, message: error.message });
            throw error;
          }
        };
        const value = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const wrappedBrowser = { contexts: () => [{ pages: () => [delayedPage] }], close: () => attached.close() };
      session = await inspectorWithBrowser(wrappedBrowser).openRuntimeSession(scope,
        { cdpURL: `http://127.0.0.1:${port}/`, runtimeURL });
      const pending = session.captureScope();
      pending.catch(() => {}); // Preserve the original rejection for assertion.
      await control.waitForFunction(() => window.__invalidationEvaluationStarted === true);
      expect(evaluations).toBe(1);
      expect(notifications).toBe(3); // Registered, not delivered.
      if (action === "navigation") await control.goto(runtimeURL + "_next");
      else if (action === "same URL reload") { await control.reload(); expect(control.url()).toBe(runtimeURL); }
      else if (action === "page close") await control.close();
      else await attached.close(); // Detach only our connection, not the user's browser.
      expect(await pending).toMatchObject({ status: "unavailable" });
      expect(observedErrors).toHaveLength(1);
      expect(observedErrors[0].message).toMatch(/Execution context was destroyed|Target page, context or browser has been closed/);
      expect(await session.captureScope()).toMatchObject({ status: "unavailable" });
      expect(await session.inspectRuntime()).toMatchObject({ status: "unavailable" });
      expect(evaluations).toBe(1); // Never retry / bind the new same-URL Document.
    } finally {
      if (session) await session.close();
      else if (attached) await attached.close();
      await context.close();
    }
  });
}
