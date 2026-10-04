"use strict";

const { inspectExistingRuntime, loopbackURL } = require("./progress-live-runtime-inspector");
const { randomUUID } = require("node:crypto");
const fixture = require("./progress-live-fixture-helpers");

// Test-only, temporary Document capability; never loaded by the application.
// History wrappers cancel synchronously (including same-URL navigation), before
// an IDB transaction can commit. CDP's later navigation event is not authority.
function installPageLifetime(key) {
  const originalDocument = document, originalURL = location.href;
  let invalid = false;
  const listeners = new Set(), historyMethods = [];
  const invalidate = () => { invalid = true; for (const fn of [...listeners]) fn(); };
  const events = ["pagehide", "beforeunload", "popstate", "hashchange", "freeze"];
  for (const event of events) window.addEventListener(event, invalidate, true);
  for (const name of ["pushState", "replaceState", "go", "back", "forward"]) {
    const original = history[name];
    const wrapped = function(...args) {
      // go/back/forward may replace the Document asynchronously: cancel before
      // initiating them. State methods cancel synchronously after success.
      if (["go", "back", "forward"].includes(name)) invalidate();
      const result = original.apply(this, args);
      invalidate(); return result;
    };
    history[name] = wrapped; historyMethods.push({ name, original, wrapped });
  }
  window.navigation?.addEventListener("navigate", invalidate);
  const lifetime = Object.freeze({
    isCurrent: () => !invalid && document === originalDocument && location.href === originalURL,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    dispose: () => {
      invalidate();
      for (const event of events) window.removeEventListener(event, invalidate, true);
      window.navigation?.removeEventListener("navigate", invalidate);
      for (const { name, original, wrapped } of historyMethods) if (history[name] === wrapped) history[name] = original;
      delete window[key];
    }
  });
  Object.defineProperty(window, key, { value: lifetime, configurable: true });
}

// Explicit test-only page operation. No HTTP, auth/session lookup, Reader
// movement, hydrate, binding creation, desired or attempt preparation.
// PRIVATE: only the verified Node capability consumer may serialize this call.
async function seedExistingFixtureObservation(input) {
  const OWNER = "db4f9c1c-4563-47a9-8649-150a4fb87a6a";
  const ID = /^b3-2b-live-fixture-a-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const denied = () => ({ status: "blocked", reason: "fixture-scope-invalid" });
  const base = input?.baseline, article = input?.server?.article, progress = input?.server?.progress;
  const def = input?.definition;
  if (input?.gates?.live !== true || input.gates.fixture !== true || input.gates.dedicated !== true ||
      base?.ownerId !== OWNER || !ID.test(def?.articleId || "") || base.runtimeIdentity !== input.runtimeIdentity ||
      !base.runtimeIdentity || base.stable !== true || base.transitionInactive !== true ||
      article?.ownerId !== OWNER || progress?.ownerId !== OWNER ||
      article.articleId !== def.articleId || progress.articleId !== def.articleId ||
      article.lifecycle !== "active" || article.readingEpoch !== progress.parentReadingEpoch ||
      article.contentFingerprint !== progress.contentFingerprint || article.contentFingerprint !== def.contentDigest ||
      progress.progress !== 0.2 || progress.paragraphIndex !== 4) return denied();
  const repo = window.LingoFlowSyncStateRepository, flow = window.LingoFlowProgressLocalDesired;
  const library = window.LingoFlowArticleLibrary, causal = window.LingoFlowProgressCausalState;
  if (!repo || !flow || !library || !causal) return denied();
  const next = causal.normalizeObservation({ kind: "revision", revision: progress.revision, cursor: progress.cursor,
    parentReadingEpoch: progress.parentReadingEpoch, contentFingerprint: progress.contentFingerprint,
    checkpoint: { progress: progress.progress, paragraphIndex: progress.paragraphIndex } });
  if (!next) return denied();
  const lifetime = window[input.pageLifetimeKey];
  if (!lifetime?.isCurrent()) return denied();
  let invalid = false, finished = false, syncDB, libraryDB, barrier;
  const invalidators = new Set();
  const invalidate = () => { invalid = true; for (const fn of [...invalidators]) fn(); };
  const callGuard = () => !invalid && !finished && lifetime.isCurrent();
  callGuard.subscribe = fn => {
    invalidators.add(fn);
    const unsubscribe = lifetime.subscribe(fn);
    return () => { invalidators.delete(fn); unsubscribe(); };
  };
  window.addEventListener("pagehide", invalidate);
  window.addEventListener("beforeunload", invalidate);
  const deadline = window.setTimeout(() => {
    invalidate();
    try { barrier?.abort(); } catch { /* already settled */ }
  }, 30000);
  try {
    const context = await flow.captureCloudResponseContext(OWNER, base.bindingId, callGuard);
    if (!context?.guard || context.generation !== base.generation || !context.guard()) return denied();
    const databases = await indexedDB.databases();
    if (!databases.some(d => d.name === "LingoFlowSyncDB" && d.version === 7) ||
        !databases.some(d => d.name === "LingoFlowLibraryDB" && d.version === 3)) return denied();
    const open = name => new Promise((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onupgradeneeded = () => req.transaction.abort();
      req.onblocked = () => reject(new Error("fixture-db-unavailable"));
      req.onerror = () => reject(new Error("fixture-db-unavailable"));
      req.onsuccess = () => resolve(req.result);
    });
    syncDB = await open("LingoFlowSyncDB"); libraryDB = await open("LingoFlowLibraryDB");
    const local = await library.getProgressContext(def.articleId,
      { ownerId: OWNER, bindingId: base.bindingId }, { initialize: false });
    if (local.status !== "ready" || local.scope.scopeToken !== base.scopeToken || local.article.deletedAt ||
        await window.LingoFlowReadingResume.fingerprintContent(local.article.content) !== article.contentFingerprint ||
        !context.guard()) return denied();
    // Hold the EXISTING Library scope/Article/fence behind a readonly barrier
    // until the SyncDB observation transaction settles. Scope replacement is
    // blocked by real IDB locks, not a fictional cross-DB atomic commit.
    let release;
    const barrierDone = new Promise(resolve => { release = resolve; });
    await new Promise((resolve, reject) => {
      barrier = libraryDB.transaction(["articles", "progressFences", "progressControl"], "readonly");
      let articleChecked = false, fenceChecked = false, scopeChecked = false;
      const ready = () => { if (articleChecked && fenceChecked && scopeChecked) resolve(); };
      const ar = barrier.objectStore("articles").get(def.articleId);
      ar.onsuccess = () => {
        if (ar.result?.id !== def.articleId || ar.result.deletedAt || ar.result.content !== local.article.content) {
          invalidate(); barrier.abort(); return;
        }
        articleChecked = true; ready();
      };
      const fr = barrier.objectStore("progressFences").get(def.articleId);
      fr.onsuccess = () => {
        if (JSON.stringify(fr.result) !== JSON.stringify(local.fence)) { invalidate(); barrier.abort(); return; }
        fenceChecked = true; ready();
      };
      const controls = barrier.objectStore("progressControl");
      const wr = controls.get("workspace");
      wr.onsuccess = () => {
        if (wr.result?.ownerId !== OWNER || wr.result.bindingId !== base.bindingId || wr.result.scopeToken !== base.scopeToken) {
          invalidate(); barrier.abort(); return;
        }
        // Native request keepalive contains only readonly gets. No crypto or
        // network is awaited inside either transaction; no durable lock record.
        const keep = () => {
          const req = controls.get("workspace-transition");
          req.onsuccess = () => {
            if (req.result || !context.guard()) { invalidate(); barrier.abort(); return; }
            if (!scopeChecked) { scopeChecked = true; ready(); }
            if (!finished) keep();
          };
        };
        keep();
      };
      barrier.onabort = barrier.onerror = () => { invalidate(); reject(new Error("fixture-library-barrier-aborted")); release(); };
      barrier.oncomplete = () => { if (!finished) invalidate(); release(); };
    });
    if (!context.guard()) return denied();
    // Production validator and monotonic writer are reused; the only change
    // is an opt-in transaction guard, checking private Progress generation.
    const parent = { articleRevision: article.revision, readingEpoch: article.readingEpoch,
      contentFingerprint: article.contentFingerprint, lifecycle: article.lifecycle };
    const result = await repo.recordProgressRemoteObservation(OWNER, base.bindingId, def.articleId, next, context.guard, parent);
    finished = true;
    window.clearTimeout(deadline);
    await barrierDone;
    return ["recorded", "unchanged"].includes(result.status) ? { status: result.status } : denied();
  } catch { return denied(); }
  finally {
    finished = true;
    window.clearTimeout(deadline);
    try { barrier?.abort(); } catch { /* already completed */ }
    syncDB?.close(); libraryDB?.close();
    window.removeEventListener("pagehide", invalidate);
    window.removeEventListener("beforeunload", invalidate);
  }
}

// Future manual injection only. Never called by the foundation CLI or app.
async function openFixtureRuntimeSession(scope, options) {
  if (scope?.ownerId !== fixture.OWNER || !fixture.ID.test(scope.articleId)) throw new Error("invalid-fixture-scope");
  const cdp = loopbackURL(options.cdpURL), runtime = loopbackURL(options.runtimeURL, true);
  const browser = await require("playwright").chromium.connectOverCDP(cdp.href, { timeout: 15000, noDefaults: true });
  try {
    const pages = browser.contexts().flatMap(c => c.pages()).filter(page => {
      try { const url = new URL(page.url()); return url.origin === runtime.origin && url.pathname === runtime.pathname; }
      catch { return false; }
    });
    if (pages.length !== 1) throw new Error("existing-runtime-page-not-unique");
    const page = pages[0], runtimeIdentity = randomUUID(), pageLifetimeKey = `__fixtureLifetime_${randomUUID()}`;
    await page.evaluate(installPageLifetime, pageLifetimeKey);
    let invalid = false;
    const invalidate = () => { invalid = true; };
    const navigation = frame => { if (frame === page.mainFrame()) invalidate(); };
    page.on("close", invalidate); page.on("crash", invalidate); page.on("framenavigated", navigation);
    const inspect = async scopeOnly => {
      if (invalid) return { status: "unavailable" };
      if (!await page.evaluate(key => window[key]?.isCurrent() === true, pageLifetimeKey)) return { status: "unavailable" };
      const value = await page.evaluate(inspectExistingRuntime, { ...scope, scopeOnly });
      return invalid || !await page.evaluate(key => window[key]?.isCurrent() === true, pageLifetimeKey)
        ? { status: "unavailable" } : { ...value, runtimeIdentity };
    };
    return { captureScope: () => inspect(true), inspectRuntime: () => inspect(false),
      seedObservation: async capability => {
        const input = fixture.consumeVerifiedFixtureSeed(capability);
        if (!input || invalid || input.baseline.runtimeIdentity !== runtimeIdentity ||
            input.baseline.ownerId !== scope.ownerId || input.definition.articleId !== scope.articleId) return { status: "blocked" };
        try {
          return await page.evaluate(seedExistingFixtureObservation, { ...input, runtimeIdentity, pageLifetimeKey });
        } catch { return { status: "blocked" }; } // Destroyed Document naturally aborts its IDB transaction.
      },
      close: async () => {
        try { await page.evaluate(key => window[key]?.dispose(), pageLifetimeKey); } catch { /* Document already destroyed. */ }
        page.off("close", invalidate); page.off("crash", invalidate); page.off("framenavigated", navigation);
        await browser.close(); // detach only, never closes the user's page
      } };
  } catch (error) { await browser.close(); throw error; }
}

module.exports = { openFixtureRuntimeSession };
