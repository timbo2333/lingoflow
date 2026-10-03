"use strict";

// Serialized into an ALREADY OPEN dedicated runtime. Never navigate, scroll,
// log in, initialize DBs, ingest observations, reconcile, or prepare an action.
async function inspectExistingRuntime(scope) {
  const handles = [];
  const unavailable = reason => ({ status: "unavailable", ...(reason ? { reason } : {}) });
  async function openExisting(name, version, stores) {
    const known = (await indexedDB.databases()).find(db => db.name === name);
    if (known?.version !== version) throw new Error("local-databases-missing-or-version-mismatch");
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(name); // No version, no schema migration.
      req.onupgradeneeded = () => { req.transaction.abort(); };
      req.onerror = () => reject(new Error("existing-db-open-failed"));
      req.onblocked = () => reject(new Error("existing-db-blocked"));
      req.onsuccess = () => resolve(req.result);
    });
    handles.push(db);
    if (db.version !== version || stores.some(store => !db.objectStoreNames.contains(store))) throw new Error("existing-db-shape-invalid");
    return db;
  }
  async function read(db, store, key, index = null) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const target = index ? tx.objectStore(store).index(index) : tx.objectStore(store);
      const req = index ? target.getAll(IDBKeyRange.only(key)) : target.get(key);
      let value;
      req.onsuccess = () => { value = req.result; };
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(new Error("read-only-transaction-failed"));
    });
  }
  try {
    const repo = window.LingoFlowSyncStateRepository;
    const lib = window.LingoFlowArticleLibrary;
    const flow = window.LingoFlowProgressLocalDesired;
    const causal = window.LingoFlowProgressCausalState;
    const auth = window.LingoFlowSupabaseAuth;
    if (!repo || !lib || !flow || !causal || !auth || !indexedDB.databases) return unavailable();
    // Hold connections throughout inspection: deletion/recreation cannot race
    // the production readonly APIs into creating a fresh database.
    const sync = await openExisting("LingoFlowSyncDB", 7, ["control", "progressDesired",
      "progressRemoteObservations", "progressCloudAttempts", "articleSidecars", "articleOutbox"]);
    const library = await openExisting("LingoFlowLibraryDB", 3, ["articles", "progressFences", "progressControl"]);
    const binding = await read(sync, "control", "workspace-binding");
    if (!binding) return unavailable("local-binding-unresolved");
    if (binding.ownerId !== scope.ownerId || auth.getState()?.status !== "authenticated" ||
        auth.getState()?.user?.id !== scope.ownerId) return unavailable("local-owner-mismatch");
    const owner = { ownerId: scope.ownerId, bindingId: binding.bindingId };
    const captureScope = async () => ({
      generation: await flow.captureCloudResponseContext(owner.ownerId, owner.bindingId),
      transition: await lib.getWorkspaceTransition(),
      workspace: await read(library, "progressControl", "workspace") });
    const scopeBefore = await captureScope();
    const scopeAfter = await captureScope();
    if (scopeBefore.transition || scopeAfter.transition) return unavailable("local-workspace-transition");
    if (!scopeBefore.generation || JSON.stringify(scopeBefore) !== JSON.stringify(scopeAfter)) {
      return unavailable("local-generation-or-state-unstable");
    }
    if (scopeBefore.workspace?.ownerId !== owner.ownerId ||
        scopeBefore.workspace?.bindingId !== owner.bindingId || !scopeBefore.workspace.scopeToken) {
      return unavailable("local-workspace-or-fence-unresolved");
    }
    const scopeFacts = { status: "ready", ...owner,
      generation: scopeBefore.generation.generation, scopeToken: scopeBefore.workspace.scopeToken,
      stable: true, transitionInactive: true };
    if (scope.scopeOnly === true) return scopeFacts; // No Article/causal inspection yet.
    const args = [owner.ownerId, owner.bindingId, scope.articleId];
    const capture = async () => ({ generation: await flow.captureCloudResponseContext(owner.ownerId, owner.bindingId),
      transition: await lib.getWorkspaceTransition(),
      local: await lib.getProgressContext(scope.articleId, owner, { initialize: false }),
      sync: await repo.getProgressCausalSnapshot(...args),
      attempts: await read(sync, "progressCloudAttempts", args, "byScope") });
    const before = await capture();
    if (before.transition || before.local.status === "workspace-transition") return unavailable("local-workspace-transition");
    if (before.local.status !== "ready") return unavailable("local-workspace-or-fence-unresolved");
    if (before.sync.status !== "ready") return unavailable("local-causal-snapshot-unavailable");
    if (!before.generation) return unavailable("local-generation-or-state-unstable");
    const article = before.local.article;
    const contentFingerprint = await window.LingoFlowReadingResume.fingerprintContent(article.content);
    const after = await capture();
    const stable = JSON.stringify(before) === JSON.stringify(after);
    const observation = before.sync.observation;
    const reader = (() => {
      // Only read existing main.js geometry/session. No showArticle() or scroll.
      if (typeof getArticleReadingMetrics !== "function" || typeof readingProgressSession === "undefined" ||
          typeof activeArticleId === "undefined" || activeArticleId !== scope.articleId ||
          readingProgressSession?.articleId !== scope.articleId) return null;
      const metrics = getArticleReadingMetrics();
      if (!metrics || !readingProgressSession.resumeBaseline) return null;
      const paragraphs = [];
      const seen = new Set();
      for (const word of metrics.article.querySelectorAll(".word[data-paragraph-index]")) {
        const index = Number(word.dataset.paragraphIndex);
        if (seen.has(index)) continue;
        if (paragraphs.length >= 4096) return null;
        seen.add(index);
        paragraphs.push({ index, top: window.scrollY + word.getBoundingClientRect().top });
      }
      return { articleId: activeArticleId, baselineArticleId: readingProgressSession.resumeBaseline.articleId,
        baselineFingerprint: readingProgressSession.contentFingerprint,
        baseline: { progress: readingProgressSession.resumeBaseline.progress,
          paragraphIndex: readingProgressSession.resumeBaseline.paragraphIndex },
        pendingSave: Boolean(readingProgressSession.resumeDirty || readingProgressSession.dirty ||
          (typeof readingProgressSaveTimer !== "undefined" && readingProgressSaveTimer) ||
          (typeof suppressReadingProgressSave !== "undefined" && suppressReadingProgressSave)),
        startY: metrics.startY, scrollRange: metrics.scrollRange, anchorOffset: metrics.anchorOffset,
        currentScrollY: window.scrollY,
        maxScrollY: Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight), paragraphs };
    })();
    const parent = causal.trustedParent(before.sync.sidecar);
    const record = before.sync.record;
    return { status: "ready", ownerId: owner.ownerId, bindingId: owner.bindingId,
      generation: before.generation.generation, scopeToken: before.local.scope?.scopeToken,
      stable, transitionInactive: !before.transition && !after.transition,
      scopeValid: before.local.scope?.ownerId === owner.ownerId && before.local.scope?.bindingId === owner.bindingId &&
        Boolean(before.local.scope.scopeToken), fencePresent: before.local.fence?.articleId === scope.articleId &&
          typeof before.local.fence.lifecycleToken === "string" && before.local.fence.lifecycleToken.length > 0 &&
          Number.isSafeInteger(before.local.fence.resumeRevision) && before.local.fence.resumeRevision >= 0,
      articleId: article.id, articleActive: !article.deletedAt, contentFingerprint,
      contentBytes: new TextEncoder().encode(article.content).length, parent,
      bootstrapSafe: before.sync.bootstrapSafe, hasConflict: before.sync.hasConflict, hasMutation: before.sync.hasMutation,
      pendingMovement: Boolean(record?.pending), quarantinedMovement: Boolean(record?.quarantined),
      // A fresh first UPDATE must not compete with an existing uncertain call.
      unsettledAttempts: before.attempts.some(attempt => !["succeeded", "terminal", "superseded", "blocked_before_dispatch"].includes(attempt.status)),
      observation, observationDiagnostic: Boolean(before.sync.observationDiagnostic), reader };
  } catch (error) {
    return unavailable(error?.message === "local-databases-missing-or-version-mismatch"
      ? "local-databases-missing-or-version-mismatch" : undefined);
  }
  finally { for (const db of handles) db.close(); }
}

function loopbackURL(value, runtime = false) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || (!runtime && url.pathname !== "/")) {
    throw new Error("local-runtime-url-invalid");
  }
  return url;
}

async function openRuntimeSession(scope, { cdpURL, runtimeURL }) {
  const cdp = loopbackURL(cdpURL);
  const runtime = loopbackURL(runtimeURL, true);
  const { chromium } = require("playwright");
  // Installed Playwright supports noDefaults: do not emulate focus/media or
  // alter download settings in the existing runtime while attaching.
  const browser = await chromium.connectOverCDP(cdp.href, { timeout: 15000, noDefaults: true });
  try {
    const pages = browser.contexts().flatMap(context => context.pages()).filter(page => {
      try { const url = new URL(page.url()); return url.origin === runtime.origin && url.pathname === runtime.pathname; }
      catch { return false; }
    });
    if (pages.length !== 1) throw new Error("existing-runtime-page-not-unique");
    const page = pages[0];
    const runtimeIdentity = require("node:crypto").randomUUID();
    let identityChanged = false;
    const invalidate = () => { identityChanged = true; };
    const navigated = frame => { if (frame === page.mainFrame()) invalidate(); };
    page.on("close", invalidate); page.on("crash", invalidate); page.on("framenavigated", navigated);
    // Only lifecycle invalidation listeners above: no tracing, HAR, screenshot,
    // video, request/console recording, or credential-bearing evaluate args.
    const evaluate = async scopeOnly => {
      if (identityChanged) return { status: "unavailable" };
      let timer;
      try {
        const result = await Promise.race([page.evaluate(inspectExistingRuntime, { ...scope, scopeOnly }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("read-only-runtime-timeout")), 30000); })]);
        return identityChanged ? { status: "unavailable" } : { ...result, runtimeIdentity };
      } finally { clearTimeout(timer); }
    };
    return { captureScope: () => evaluate(true), inspectRuntime: () => evaluate(false),
      close: async () => {
        page.off("close", invalidate); page.off("crash", invalidate); page.off("framenavigated", navigated);
        await browser.close(); // Disconnect only; existing browser/page stay open.
      } };
  } catch (error) { await browser.close(); throw error; }
}

async function inspectRuntime(scope, options) {
  const session = await openRuntimeSession(scope, options);
  try { return await session.inspectRuntime(); }
  finally { await session.close(); }
}

module.exports = { inspectExistingRuntime, loopbackURL, inspectRuntime, openRuntimeSession };
